import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendOf } from "./mirror-fixtures.ts";
import { cleanup, fileText, fresh, MiB, open, refusals } from "./mirror-harness.ts";

afterEach(cleanup);

/** Pi's own writer, from the installed SDK: the entries the mirror will really meet (AVM-E27). */
async function piSession(dir: string): Promise<string> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sm = SessionManager.create(join(dir, "cwd"), join(dir, "sessions"));
  const user = sm.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "yo" }], timestamp: 2 } as never);
  sm.appendMessage({
    role: "user",
    content: [{ type: "image", data: "A".repeat(2 * MiB), mimeType: "image/png" }],
    timestamp: 3,
  } as never);
  sm.appendModelChange("anthropic", "claude");
  sm.appendThinkingLevelChange("high");
  // `custom`: type, customType, data, id. The data holds an id of its own. pap writes one of these (`pap:memory-trust`).
  sm.appendCustomEntry("pap:memory-trust", { id: "nested-id", trusted: true });
  // `custom_message`: type, customType, content, display, details, id; here over 1 MiB.
  sm.appendCustomMessageEntry("my-ext", "x".repeat(MiB + 4096), true, { id: "nested-detail" });
  sm.appendLabelChange(user, "bookmark");
  sm.appendSessionInfo("a name");
  sm.appendCompaction("summary", user, 100, {}, false);
  sm.branchWithSummary(user, "branch summary", {}, false);
  const file = sm.getSessionFile();
  if (file === undefined) throw new Error("Pi wrote no session file");
  return readFileSync(file, "utf8");
}

describe("every entry Pi writes goes through the mirror, closes and reopens (AVM-E27)", () => {
  it("takes the ids of all entry types, `custom` and a 1 MiB `custom_message` included, and reopens without parsing", async () => {
    fresh();
    const dir = mkdtempSync(join(tmpdir(), "pap-pi-"));
    try {
      const text = await piSession(dir);
      const lines = text.split("\n").filter(Boolean);
      const types = lines.map((line) => (JSON.parse(line) as { type: string }).type);
      for (const type of [
        "session",
        "message",
        "model_change",
        "thinking_level_change",
        "label",
        "session_info",
        "compaction",
        "branch_summary",
        "custom",
        "custom_message",
      ])
        expect(types, type).toContain(type);
      expect(lines.some((line) => line.length > MiB)).toBe(true);
      const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id);

      const mirror = open();
      const step = 700 * 1024;
      const bytes = Buffer.from(text);
      for (let at = 0; at < bytes.length; at += step) {
        const result = await mirror.onSessionAppend(appendOf(at, bytes.subarray(at, at + step)));
        expect(result, `chunk at ${at}: ${JSON.stringify(refusals())}`).toBe("ok");
      }
      expect(mirror.facts()).toEqual({ size: bytes.length, lastEntryId: ids.at(-1) });
      expect(fileText()).toBe(text);
      mirror.close();

      const parse = vi.spyOn(JSON, "parse");
      try {
        const again = open();
        expect(again.facts()).toEqual({ size: bytes.length, lastEntryId: ids.at(-1) });
        // No line is parsed on the event loop at open, a long one least of all (AVM-E27).
        expect(parse).not.toHaveBeenCalled();
        // The ids are the ones read at append: a repeat of any of them is a duplicate, the nested ones are not ids.
        const next = bytes.length;
        const repeat = `${JSON.stringify({ type: "label", id: ids[3], parentId: null })}\n`;
        expect(await again.onSessionAppend(appendOf(next, repeat))).toBe("refused");
      } finally {
        parse.mockRestore();
      }
      const third = open();
      const nested = `${JSON.stringify({ type: "label", id: "nested-id", parentId: null })}\n`;
      expect(await third.onSessionAppend(appendOf(bytes.length, nested))).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
