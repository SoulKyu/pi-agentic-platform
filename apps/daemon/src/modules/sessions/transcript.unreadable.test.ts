import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { LogFields, Logger } from "../../kernel/logger.ts";

// Pi's converter throws on an entry with this id: the reader must show nothing for it and say so, rate limited.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  CURRENT_SESSION_VERSION: 3,
  migrateSessionEntries: () => {},
  sessionEntryToContextMessages: (entry: { id: string; message?: unknown }) => {
    if (entry.id.startsWith("bad")) throw new Error("secret detail /home/x");
    return [entry.message];
  },
}));
import { loadTranscriptReader } from "./transcript.ts";

const dir = mkdtempSync(join(tmpdir(), "pap-unreadable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const logged: Array<{ msg: string; fields: LogFields | undefined }> = [];
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, fields) => void logged.push({ msg, fields }),
  error: () => {},
  child: () => logger,
};
const clock = createFakeClock();

const entry = (id: string, parentId: string | null) =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "t",
    message: { role: "user", content: id, timestamp: 1 },
  });

describe("an entry Pi's converter throws on (M2-RT-33)", () => {
  it("shows as nothing, is said at most once every 10 s, and never carries the error text", async () => {
    const reader = await loadTranscriptReader({ logger, clock });
    const file = join(dir, "s.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/w" });
    writeFileSync(
      file,
      [header, entry("e1", null), entry("bad1", "e1"), entry("bad2", "bad1"), entry("e2", "bad2")].join(
        "\n",
      ) + "\n",
    );
    expect(reader.page(file).rows.map((row) => row.entryId)).toEqual(["e1", "e2"]);
    reader.page(file);
    reader.page(file, { limit: 1 });
    const said = () => logged.filter((line) => line.msg === "transcript_entry_unreadable");
    expect(said()).toHaveLength(1);
    expect(said()[0]?.fields).toEqual({ type: "message", suppressed: 0 });
    await clock.advance(10_001);
    reader.page(file);
    expect(said()).toHaveLength(2);
    expect(said()[1]?.fields?.suppressed).toBeGreaterThan(0);
  });
});
