import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPiWriter, type PiWriter } from "./pi-writer.ts";
import { sessionFileText } from "./testing/pi-file-writers.ts";

let dir: string;
let scratch: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-writer-"));
  scratch = join(dir, "fork-tmp");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writer = (): Promise<PiWriter> => loadPiWriter(scratch);
const sessionsDir = () => {
  const folder = join(dir, "agent", "sessions", "--w--");
  mkdirSync(folder, { recursive: true });
  return folder;
};
function writeSession(exchanges: ReadonlyArray<readonly [string, string]>, name = "src.jsonl"): string {
  const file = join(sessionsDir(), name);
  writeFileSync(file, sessionFileText("pi-src", exchanges));
  return file;
}
interface Line {
  type: string;
  id: string;
  name?: string;
  parentSession?: string;
  message: { role: string };
}
const linesOf = (file: string): Line[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line);
const leftovers = () => {
  try {
    return readdirSync(scratch);
  } catch {
    return [];
  }
};

describe("fork", () => {
  it("forks before a user message: the new file holds the branch above it, the text comes back", async () => {
    const w = await writer();
    const source = writeSession([
      ["q0", "r0"],
      ["q1", "r1"],
    ]);
    const before = readFileSync(source, "utf8");
    const forked = w.fork(source, "u1");
    expect(forked.text).toBe("q1");
    expect(forked.file).not.toBeNull();
    const roles = linesOf(forked.file ?? "")
      .filter((line) => line.type === "message")
      .map((line) => `${line.message.role}:${line.id}`);
    expect(roles).toEqual(["system:s0", "user:u0", "assistant:a0"]);
    expect(readFileSync(source, "utf8")).toBe(before);
    expect(dirname(forked.file ?? "")).toBe(dirname(source));
    expect(leftovers()).toEqual([]);
  });

  it("records the real source, not the working copy, as the parent", async () => {
    const w = await writer();
    const source = writeSession([
      ["q0", "r0"],
      ["q1", "r1"],
    ]);
    const forked = w.fork(source, "u1");
    expect(linesOf(forked.file ?? "")[0]).toMatchObject({ type: "session", parentSession: source });
    const cloned = w.clone(source, null, null);
    expect(linesOf(cloned.file)[0]).toMatchObject({ type: "session", parentSession: source });
  });

  it("forks at the first message as a draft, and refuses an entry that is not a user message", async () => {
    const w = await writer();
    const source = writeSession([["q0", "r0"]]);
    expect(w.fork(source, "u0")).toEqual({ file: null, piSessionId: null, text: "q0" });
    expect(() => w.fork(source, "a0")).toThrow(expect.objectContaining({ refusal: "not_a_user_message" }));
    expect(() => w.fork(source, "nope")).toThrow(expect.objectContaining({ refusal: "not_a_user_message" }));
    expect(readdirSync(dirname(source))).toEqual(["src.jsonl"]);
    expect(leftovers()).toEqual([]);
  });
});

describe("clone", () => {
  it("clones the branch at a leaf and names the copy, leaving the source untouched", async () => {
    const w = await writer();
    const source = writeSession([
      ["q0", "r0"],
      ["q1", "r1"],
    ]);
    const before = readFileSync(source, "utf8");
    const cloned = w.clone(source, "a0", "Fix login · 3f9a");
    const entries = linesOf(cloned.file);
    expect(entries.filter((line) => line.type === "message").map((line) => line.id)).toEqual([
      "s0",
      "u0",
      "a0",
    ]);
    expect(entries.at(-1)).toMatchObject({ type: "session_info", name: "Fix login · 3f9a" });
    expect(readFileSync(source, "utf8")).toBe(before);
    expect(() => w.clone(writeSession([], "empty-branch.jsonl"), null, null)).toThrow(
      expect.objectContaining({ refusal: "empty" }),
    );
    expect(leftovers()).toEqual([]);
  });

  it("falls back to the last entry on disk when the leaf is not in the file", async () => {
    const w = await writer();
    const source = writeSession([["q0", "r0"]]);
    const cloned = w.clone(source, "not-yet-written", null);
    expect(
      linesOf(cloned.file)
        .filter((line) => line.type === "message")
        .map((line) => line.id),
    ).toEqual(["s0", "u0", "a0"]);
  });
});

describe("a source that must never be written (M2-RT-16)", () => {
  it("refuses a source in an older format or empty, and leaves its bytes as they were", async () => {
    const w = await writer();
    const old = join(sessionsDir(), "old.jsonl");
    const text = sessionFileText("pi-old", [["q0", "r0"]]).replace('"version":3', '"version":2');
    writeFileSync(old, text);
    expect(() => w.clone(old, null, null)).toThrow(expect.objectContaining({ refusal: "unreadable" }));
    expect(() => w.fork(old, "u0")).toThrow(expect.objectContaining({ refusal: "unreadable" }));
    expect(readFileSync(old, "utf8")).toBe(text);
    const empty = join(sessionsDir(), "empty.jsonl");
    writeFileSync(empty, "");
    expect(() => w.clone(empty, null, null)).toThrow(expect.objectContaining({ refusal: "unreadable" }));
    expect(readFileSync(empty, "utf8")).toBe("");
    const notPi = join(sessionsDir(), "not-pi.jsonl");
    writeFileSync(notPi, '{"hello":"world"}\n');
    expect(() => w.clone(notPi, null, null)).toThrow(expect.objectContaining({ refusal: "unreadable" }));
    expect(readFileSync(notPi, "utf8")).toBe('{"hello":"world"}\n');
    expect(() => w.clone(join(dir, "missing.jsonl"), null, null)).toThrow(
      expect.objectContaining({ refusal: "unreadable" }),
    );
    expect(leftovers()).toEqual([]);
  });

  it("does not touch a source whose last line is torn: Pi's open() would append a newline to it", async () => {
    const w = await writer();
    const source = writeSession([
      ["q0", "r0"],
      ["q1", "r1"],
    ]);
    appendFileSync(source, '{"type":"message","id":"u9","parentId":"a1","message":{"role":"us');
    const torn = readFileSync(source);
    const cloned = w.clone(source, null, null);
    // The torn line is not in the copy, and the last complete entry is its leaf.
    expect(
      linesOf(cloned.file)
        .filter((line) => line.type === "message")
        .map((line) => line.id),
    ).toEqual(["s0", "u0", "a0", "u1", "a1"]);
    const forked = w.fork(source, "u1");
    expect(forked.text).toBe("q1");
    expect(readFileSync(source).equals(torn)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a source over the size cap before reading it", async () => {
    const w = await loadPiWriter(scratch, { maxSourceBytes: 100 });
    const source = writeSession([["q0", "r0"]]);
    const before = readFileSync(source);
    expect(() => w.clone(source, null, null)).toThrow(expect.objectContaining({ refusal: "too_large" }));
    expect(() => w.fork(source, "u0")).toThrow(expect.objectContaining({ refusal: "too_large" }));
    expect(readFileSync(source).equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);
  });
});
