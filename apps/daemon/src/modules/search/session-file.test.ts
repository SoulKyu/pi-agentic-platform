import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HEAD_CHARS,
  HEADER_MAX_BYTES,
  MAX_LINE_BYTES,
  openRegular,
  parseHeader,
  readHeaderLine,
  readLines,
} from "./session-file.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-session-file-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
const open = (path: string) => {
  const result = openRegular(path);
  if (!("fd" in result)) throw new Error(`refused: ${result.refused}`);
  return result;
};

const header = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: "0f9a2c1e-1111-4222-8333-944455556666",
    timestamp: "2026-10-12T10:00:00.000Z",
    cwd: "/w/api",
    ...patch,
  });

describe("parseHeader (M4R57)", () => {
  it("reads a Pi header", () => {
    expect(parseHeader(header())).toEqual({
      id: "0f9a2c1e-1111-4222-8333-944455556666",
      cwd: "/w/api",
      createdAt: Date.parse("2026-10-12T10:00:00.000Z"),
    });
  });
  it("refuses anything else", () => {
    for (const line of [
      "not json",
      "null",
      JSON.stringify({ type: "message" }),
      header({ id: "" }),
      header({ id: "-dash" }),
      header({ id: "a".repeat(129) }),
      header({ id: "../x" }),
      header({ cwd: "relative" }),
      header({ cwd: "/a\u0000b" }),
      header({ cwd: `/${"a".repeat(4096)}` }),
      header({ timestamp: "yesterday" }),
      header({ timestamp: 5 }),
    ])
      expect(parseHeader(line), line.slice(0, 60)).toBeNull();
  });
});

describe("reading lines from an offset (M4R58)", () => {
  it("returns complete lines only, and the offset after the last one", () => {
    const path = write(
      "a.jsonl",
      `${header()}\n{"type":"x","id":"1"}\n{"type":"y","id":"2"}\n{"type":"z","id`,
    );
    const file = open(path);
    const head = readHeaderLine(file.fd, file.size);
    expect(head?.line).toBe(header());
    const read = readLines(file.fd, (head?.end ?? 0) + 1, file.size);
    expect(read.records.map((record) => record.type)).toEqual(["x", "y"]);
    expect(read.next).toBe(Buffer.byteLength(`${header()}\n{"type":"x","id":"1"}\n{"type":"y","id":"2"}\n`));
    closeSync(file.fd);
  });

  it("stops at the budget, on a line boundary, and goes on from there", () => {
    // Lines 0-9 are 130 bytes and a newline: the 8th ends at byte 1048, the first boundary at or past 1000 (RT-24).
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ type: "m", id: String(i), pad: "p".repeat(100) }),
    );
    const path = write("b.jsonl", `${lines.join("\n")}\n`);
    const file = open(path);
    const first = readLines(file.fd, 0, file.size, 1000);
    expect([first.records.length, first.next, first.skipping]).toEqual([8, 1048, false]);
    const rest = readLines(file.fd, first.next, file.size);
    expect([...first.records, ...rest.records].map((record) => record.id)).toEqual(
      lines.map((_, i) => String(i)),
    );
    closeSync(file.fd);
  });

  it("skips a line over MAX_LINE_BYTES without parsing it, and counts unparsable lines", () => {
    const big = `{"type":"toolResult","x":"${"x".repeat(MAX_LINE_BYTES)}"}`;
    const path = write("c.jsonl", `{"type":"a","id":"1"}\n${big}\nnot json\n{"type":"b","id":"2"}\n`);
    const file = open(path);
    const read = readLines(file.fd, 0, file.size, MAX_LINE_BYTES * 2);
    expect(read.records.map((record) => record.type)).toEqual(["a", "b"]);
    expect([read.skipped, read.bad]).toEqual([1, 1]);
    closeSync(file.fd);
  });

  it("crosses a line far over the cap in bounded calls, never reading a byte twice (RT-23)", () => {
    const MiB = 1024 * 1024;
    const path = write(
      "long.jsonl",
      `{"type":"a","id":"1"}\n${"x".repeat(20 * MiB)}\n{"type":"b","id":"2"}\n`,
    );
    const file = open(path);
    // At most budget + MAX_LINE_BYTES (9 MiB) per call; the cursor keeps where the skip stopped.
    const first = readLines(file.fd, 0, file.size, MiB);
    expect(first).toEqual({
      records: [{ type: "a", id: "1" }],
      next: 9 * MiB,
      bad: 0,
      skipped: 0,
      skipping: true,
    });
    const second = readLines(file.fd, first.next, file.size, MiB, true);
    expect(second).toEqual({ records: [], next: 18 * MiB, bad: 0, skipped: 0, skipping: true });
    const third = readLines(file.fd, second.next, file.size, MiB, true);
    expect(third).toEqual({ records: [], next: 22 + 20 * MiB + 1, bad: 0, skipped: 1, skipping: false });
    const fourth = readLines(file.fd, third.next, file.size, MiB);
    expect(fourth).toEqual({
      records: [{ type: "b", id: "2" }],
      next: file.size,
      bad: 0,
      skipped: 0,
      skipping: false,
    });
    closeSync(file.fd);
  });

  it("clamps a call at budget + MAX_LINE_BYTES for a non-aligned budget", () => {
    const MiB = 1024 * 1024;
    const file = open(write("clamp.jsonl", `${"x".repeat(20 * MiB)}\n`));
    const read = readLines(file.fd, 0, file.size, 1000);
    expect([read.next, read.skipping, read.records]).toEqual([1000 + MAX_LINE_BYTES, true, []]);
    closeSync(file.fd);
  });

  it("keeps a multi-byte character straddling a 1 MiB read boundary intact", () => {
    const MiB = 1024 * 1024;
    const text = `${"a".repeat(MiB - 1)}\u00e9\u{1F600}`;
    const body = `${JSON.stringify({ type: "m", text })}\n`;
    const file = open(write("utf.jsonl", body));
    const read = readLines(file.fd, 0, file.size, 4 * MiB);
    expect(read.records).toEqual([{ type: "m", text }]);
    expect(read.next).toBe(Buffer.byteLength(body));
    closeSync(file.fd);
  });

  it("reads nothing from an empty file or past a header-only one", () => {
    const empty = open(write("empty.jsonl", ""));
    expect(readLines(empty.fd, 0, empty.size)).toEqual({
      records: [],
      next: 0,
      bad: 0,
      skipped: 0,
      skipping: false,
    });
    closeSync(empty.fd);
    const only = open(write("only.jsonl", `${header()}\n`));
    const head = readHeaderLine(only.fd, only.size);
    const from = (head?.end ?? 0) + 1;
    expect(readLines(only.fd, from, only.size)).toEqual({
      records: [],
      next: from,
      bad: 0,
      skipped: 0,
      skipping: false,
    });
    closeSync(only.fd);
  });

  it("finds no header line until its newline is written, nor one past 64 KiB", () => {
    const partial = open(write("d.jsonl", header()));
    expect(readHeaderLine(partial.fd, partial.size)).toBeNull();
    closeSync(partial.fd);
    const long = open(write("e.jsonl", `${header({ pad: "x".repeat(HEADER_MAX_BYTES) })}\n`));
    expect(readHeaderLine(long.fd, long.size)).toBeNull();
    closeSync(long.fd);
  });
});

describe("limits", () => {
  it("keeps the cursor head at 512 characters (read by the scanner, Task 15)", () => {
    expect(HEAD_CHARS).toBe(512);
  });
});

describe("openRegular (M4R56)", () => {
  it("refuses a link, a FIFO and a missing file, and never blocks", () => {
    const target = write("real.jsonl", `${header()}\n`);
    symlinkSync(target, join(dir, "link.jsonl"));
    expect(openRegular(join(dir, "link.jsonl"))).toEqual({ refused: "ELOOP" });
    execFileSync("mkfifo", [join(dir, "pipe.jsonl")]);
    expect(openRegular(join(dir, "pipe.jsonl"))).toEqual({ refused: "not_file" });
    expect(openRegular(join(dir, "gone.jsonl"))).toEqual({ refused: "ENOENT" });
  });
});
