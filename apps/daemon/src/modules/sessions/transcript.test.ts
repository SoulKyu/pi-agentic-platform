import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { LogFields, Logger } from "../../kernel/logger.ts";
import { loadTranscriptReader } from "./transcript.ts";

// Wraps the reads of the file system so a test can see how many bytes of a file were asked for.
const reads = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: ((fd: number, buffer: NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      const result = (actual.readSync as (...args: unknown[]) => number)(fd, buffer, ...rest);
      reads.bytes += result;
      return result;
    }) as typeof actual.readSync,
  };
});

const logged: Array<{ msg: string; fields: LogFields | undefined }> = [];
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, fields) => void logged.push({ msg, fields }),
  error: () => {},
  child: () => logger,
};
const clock = createFakeClock();
const reader = await loadTranscriptReader({ logger, clock });

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

const rolesOf = (rows: Array<{ message: unknown }>) =>
  rows.map((row) => (row.message as { role: string }).role);
const roles = (file: string, options?: Parameters<typeof reader.page>[1]) =>
  rolesOf(reader.page(file, options).rows);

describe("transcript reader", () => {
  beforeEach(async () => {
    logged.length = 0;
    // Each kind of log line is said once per 10 s: a new window for every test.
    await clock.advance(10_001);
  });

  it("gives an empty page, and no log line, for a missing file", () => {
    expect(reader.page(join(dir, "missing.jsonl"))).toEqual({
      rows: [],
      hasMore: false,
      oldestEntryId: null,
      turnsBefore: 0,
      leafId: null,
    });
    expect(logged).toEqual([]);
  });

  it("gives an empty page for a file of lines that are not JSON, and says so once", () => {
    writeFileSync(join(dir, "bad.jsonl"), "not json\n");
    expect(roles(join(dir, "bad.jsonl"))).toEqual([]);
    expect(logged).toEqual([
      { msg: "session_file_issue", fields: expect.objectContaining({ issue: "bad_lines" }) },
    ]);
  });

  it("gives an empty page and one read_failed line for a file it cannot read, then the rows once it can", () => {
    const file = join(dir, "locked.jsonl");
    writeFileSync(file, jsonl(lines));
    chmodSync(file, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root reads anything: the case cannot be built
      expect(roles(file)).toEqual([]);
      expect(logged).toEqual([
        { msg: "session_file_issue", fields: expect.objectContaining({ issue: "read_failed" }) },
      ]);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(roles(file)).toEqual(["user", "assistant"]);
  });

  it("says a directory is unreadable, and never opens a pipe (it would block the loop for good)", () => {
    mkdirSync(join(dir, "folder.jsonl"));
    expect(roles(join(dir, "folder.jsonl"))).toEqual([]);
    expect(logged.map((line) => line.fields?.issue)).toEqual(["read_failed"]);
    execFileSync("mkfifo", [join(dir, "pipe.jsonl")]);
    expect(roles(join(dir, "pipe.jsonl"))).toEqual([]);
  });

  it("reads the active branch of a Pi session file with entry ids, keeping only the tail", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, jsonl(lines));
    expect(roles(file)).toEqual(["user", "assistant"]);
    expect(reader.page(file).rows.map((row) => row.entryId)).toEqual(["a1", "a2"]);
    expect(roles(file, { limit: 1 })).toEqual(["assistant"]);
    expect(reader.page(file, { limit: 1 })).toMatchObject({
      hasMore: true,
      oldestEntryId: "a2",
      turnsBefore: 1,
    });
    expect(reader.lastEntryId(file)).toBe("a2");
    expect(reader.lastEntryId(join(dir, "missing.jsonl"))).toBeNull();
  });

  it("reads only the first bytes of the file when asked, which is how a run in progress is left out", () => {
    const file = join(dir, "s.jsonl");
    const before = jsonl(lines.slice(0, 2));
    writeFileSync(file, jsonl(lines));
    expect(roles(file, { upToBytes: Buffer.byteLength(before) })).toEqual(["user"]);
    expect(reader.page(file, { upToBytes: 0 }).rows).toEqual([]);
  });

  it("leaves out the system prompt Pi keeps in the file as a message (R107)", () => {
    const file = join(dir, "s.jsonl");
    const system = {
      type: "message",
      id: "s0",
      parentId: null,
      timestamp: "2026-10-10T00:00:00.500Z",
      message: { role: "system", content: "", sections: { preamble: "You are an expert" }, timestamp: 0 },
    };
    writeFileSync(file, jsonl([lines[0], system, { ...lines[1], parentId: "s0" }, lines[2]]));
    expect(roles(file)).toEqual(["user", "assistant"]);
    // The cap counts the rows that are left, not the ones that were hidden.
    expect(roles(file, { limit: 2 })).toEqual(["user", "assistant"]);
  });

  it("shows a compaction as a summary row and the history before it", () => {
    const file = join(dir, "s.jsonl");
    const compaction = {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-10-10T00:00:03.000Z",
      summary: "earlier work",
      firstKeptEntryId: "a2",
      tokensBefore: 900,
    };
    writeFileSync(file, jsonl([...lines, compaction]));
    expect(roles(file)).toEqual(["user", "assistant", "compactionSummary"]);
  });

  it("follows the leaf it is given", () => {
    const file = join(dir, "s.jsonl");
    const sibling = {
      ...lines[1],
      id: "b1",
      parentId: "a1",
      message: { role: "user", content: "other", timestamp: 3 },
    };
    writeFileSync(file, jsonl([...lines, sibling]));
    expect(reader.page(file).rows.map((row) => row.entryId)).toEqual(["a1", "b1"]);
    expect(reader.page(file, { leafId: "a2" }).rows.map((row) => row.entryId)).toEqual(["a1", "a2"]);
    expect(reader.forks(file, "a2")).toEqual([
      {
        parentId: "a1",
        choices: [
          expect.objectContaining({ entryId: "a2", target: "a2", onPath: true }),
          expect.objectContaining({ entryId: "b1", target: "b1", onPath: false }),
        ],
      },
    ]);
  });

  it("finds a tool call's arguments and result, and clips the rows it shows", () => {
    const file = join(dir, "s.jsonl");
    const big = "z".repeat(100_000);
    const call = {
      type: "message",
      id: "t1",
      parentId: "a2",
      timestamp: "t",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "f" } }],
        timestamp: 3,
      },
    };
    const result = {
      type: "message",
      id: "t2",
      parentId: "t1",
      timestamp: "t",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: big }],
        timestamp: 4,
      },
    };
    writeFileSync(file, jsonl([...lines, call, result]));
    const shown = reader.page(file).rows.at(-1)?.message as { papTruncated?: unknown; content: unknown };
    expect(shown.papTruncated).toBeDefined();
    expect(JSON.stringify(shown.content).length).toBeLessThan(big.length);
    const found = reader.toolCall(file, "call-1");
    expect(found.args).toEqual({ path: "f" });
    expect(JSON.stringify(found.result)).toContain(big);
  });

  it("returns a finite page for a file whose entries point at each other (M2-RT-03)", () => {
    const file = join(dir, "s.jsonl");
    const loop = (id: string, parentId: string) => ({ ...lines[1], id, parentId });
    writeFileSync(file, jsonl([lines[0], loop("x", "y"), loop("y", "x"), loop("z", "z")]));
    expect(reader.page(file, { leafId: "x" }).rows.map((row) => row.entryId)).toEqual(["y", "x"]);
    expect(reader.page(file).rows.map((row) => row.entryId)).toEqual(["z"]);
  });

  it("reads nothing again for a file that did not change, and only the new lines for an appended one", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, jsonl(lines.slice(0, 2)));
    roles(file);
    reads.bytes = 0;
    roles(file);
    expect(reads.bytes).toBe(0);
    const added = jsonl([lines[2]]);
    appendFileSync(file, added);
    reads.bytes = 0;
    expect(roles(file)).toEqual(["user", "assistant"]);
    // The header is compared (the first 64 KiB of a file are read for it; this file is smaller), then only the
    // appended bytes are parsed: the entries already read are not read again.
    expect(reads.bytes).toBe(Buffer.byteLength(jsonl(lines)) + Buffer.byteLength(added));
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
    expect(roles(file)).toEqual(["user"]);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(modified);
  });
});
