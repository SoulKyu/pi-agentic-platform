import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extract } from "./extract.ts";
import { closeSync } from "node:fs";
import { openRegular, parseHeader, readHeaderLine, readLines } from "./session-file.ts";
import { sessionFileText } from "../sessions/testing/pi-file-writers.ts";

type Rec = Record<string, unknown>;
const message = (id: string, message: Rec, timestamp: unknown = "2026-10-12T10:00:00.000Z"): Rec => ({
  type: "message",
  id,
  timestamp,
  message,
});
const user = (id: string, content: unknown, at?: unknown): Rec =>
  message(id, { role: "user", content, timestamp: 7 }, at);
const assistant = (id: string, content: unknown[]): Rec =>
  message(id, { role: "assistant", content, timestamp: 8 });

describe("extract (M4R59)", () => {
  it("indexes user and assistant texts only, from the Pi fixture builder", () => {
    const records = sessionFileText("p1", [
      ["hi", "hello"],
      ["again", "yes"],
    ])
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Rec);
    records.push(
      message("t0", { role: "toolResult", content: [{ type: "text", text: "tool out" }] }),
      message("c0", { role: "custom", content: "custom text" }),
      assistant("a9", [
        { type: "thinking", thinking: "hmm" },
        { type: "toolCall", name: "read" },
      ]),
    );
    const out = extract(records);
    expect(out.rows).toEqual([
      { entryId: "u0", role: "user", at: Date.parse("2026-10-10T00:00:01.000Z"), text: "hi" },
      { entryId: "a0", role: "assistant", at: Date.parse("2026-10-10T00:00:02.000Z"), text: "hello" },
      { entryId: "u1", role: "user", at: Date.parse("2026-10-10T00:00:01.000Z"), text: "again" },
      { entryId: "a1", role: "assistant", at: Date.parse("2026-10-10T00:00:02.000Z"), text: "yes" },
    ]);
    expect(out.firstUser).toBe("hi");
    expect(out.active).toBe(true);
    expect(out.name).toBeUndefined();
  });

  it("keeps the last session_info name", () => {
    expect(
      extract([
        { type: "session_info", name: "one" },
        { type: "session_info", name: "two" },
      ]).name,
    ).toBe("two");
    expect(extract([{ type: "session_info" }]).name).toBeNull();
    expect(extract([]).name).toBeUndefined();
  });

  it("joins the text blocks of an assistant message and reads user text blocks", () => {
    const out = extract([
      assistant("a1", [
        { type: "thinking" },
        { type: "text", text: "a" },
        { type: "toolCall" },
        { type: "text", text: "b" },
      ]),
      user("u1", [{ type: "text", text: "x" }, { type: "image" }, { type: "text", text: "y" }]),
    ]);
    expect(out.rows.map((row) => row.text)).toEqual(["a\nb", "x\ny"]);
  });

  it("does not index an assistant string content, nor an overlong entry id", () => {
    const out = extract([
      message("a1", { role: "assistant", content: "plain" }),
      user("i".repeat(129), "long id"),
    ]);
    expect(out.rows).toEqual([]);
    expect(out.firstUser).toBe("long id");
    expect(out.active).toBe(true);
  });

  it("gives no row for whitespace, but the message is activity", () => {
    const out = extract([user("u1", "  \n ")]);
    expect(out).toEqual({ rows: [], name: undefined, firstUser: null, active: true });
  });

  it("is not active for other entries", () => {
    expect(extract([{ type: "model_change" }, message("s", { role: "system", content: "x" })]).active).toBe(
      false,
    );
  });

  it("takes the time from the entry, else the message, else 0, clamped", () => {
    const rows = extract([
      user("a", "one", "2026-10-12T10:00:00.000Z"),
      user("b", "two", "garbage"),
      message("c", { role: "user", content: "three" }, null),
      message("d", { role: "user", content: "four", timestamp: 1e20 }, null),
      message("e", { role: "user", content: "five", timestamp: -5 }, null),
    ]).rows.map((row) => row.at);
    expect(rows).toEqual([Date.parse("2026-10-12T10:00:00.000Z"), 7, 0, 8.64e15, 0]);
  });

  it("sanitises text with indexText", () => {
    expect(extract([user("u", "a\u0000b\u200Bc")]).rows[0]?.text).toBe("a bc");
  });
});

describe("the real Pi format (RT-13)", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pap-extract-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", tmp);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads a file written by the SDK's SessionManager", () => {
    const manager = SessionManager.create("/w", join(tmp, "sessions", "--w--"));
    manager.appendMessage({ role: "user", content: "hello from pi", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
      api: "anthropic-messages",
      provider: "x",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    manager.appendSessionInfo("Named by pi");
    const path = manager.getSessionFile() ?? "";
    expect(path.startsWith(tmp)).toBe(true);
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);

    const file = openRegular(path);
    if (!("fd" in file)) throw new Error(file.refused);
    try {
      const head = readHeaderLine(file.fd, file.size);
      expect(parseHeader(head?.line ?? "")?.id).toBe(manager.getSessionId());
      const read = readLines(file.fd, (head?.end ?? 0) + 1, file.size);
      const out = extract(read.records);
      expect(out.rows.map((row) => [row.role, row.text])).toEqual([
        ["user", "hello from pi"],
        ["assistant", "hi there"],
      ]);
      expect(out.name).toBe("Named by pi");
    } finally {
      closeSync(file.fd);
    }
  });
});
