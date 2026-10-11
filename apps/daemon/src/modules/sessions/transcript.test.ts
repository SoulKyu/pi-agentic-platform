import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTranscriptTail } from "./transcript.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-transcript-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const lines = [
  {
    type: "session",
    version: 3,
    id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-10-10T00:00:00.000Z",
    cwd: "/w",
  },
  {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: "2026-10-10T00:00:01.000Z",
    message: { role: "user", content: "hi", timestamp: 1 },
  },
  {
    type: "message",
    id: "a2",
    parentId: "a1",
    timestamp: "2026-10-10T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "x",
      provider: "x",
      model: "x",
      usage,
      stopReason: "stop",
      timestamp: 2,
    },
  },
];
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const rolesOf = (messages: unknown[]) => messages.map((m) => (m as { role: string }).role);

describe("readTranscriptTail", () => {
  it("returns nothing for a missing or unreadable file", () => {
    expect(readTranscriptTail(join(dir, "missing.jsonl"))).toEqual([]);
    writeFileSync(join(dir, "bad.jsonl"), "not json\n");
    expect(readTranscriptTail(join(dir, "bad.jsonl"))).toEqual([]);
  });

  it("reads the active branch of a Pi session file, keeping only the tail", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, jsonl(lines));
    expect(rolesOf(readTranscriptTail(file))).toEqual(["user", "assistant"]);
    expect(rolesOf(readTranscriptTail(file, 1))).toEqual(["assistant"]);
  });

  it("reads only the first bytes of the file when asked, which is how a run in progress is left out", () => {
    const file = join(dir, "s.jsonl");
    const before = jsonl(lines.slice(0, 2));
    writeFileSync(file, jsonl(lines));
    expect(rolesOf(readTranscriptTail(file, 75, Buffer.byteLength(before)))).toEqual(["user"]);
    expect(readTranscriptTail(file, 75, 0)).toEqual([]);
  });

  it("migrates an old file in memory only: the bytes on disk stay as they were", () => {
    const file = join(dir, "v1.jsonl");
    writeFileSync(
      file,
      jsonl([
        {
          type: "session",
          id: "11111111-1111-4111-8111-111111111111",
          timestamp: "2026-10-10T00:00:00.000Z",
          cwd: "/w",
        },
        {
          type: "message",
          timestamp: "2026-10-10T00:00:01.000Z",
          message: { role: "user", content: "hi", timestamp: 1 },
        },
      ]),
    );
    const bytes = readFileSync(file);
    const modified = statSync(file).mtimeMs;
    expect(rolesOf(readTranscriptTail(file))).toEqual(["user"]);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(modified);
  });
});
