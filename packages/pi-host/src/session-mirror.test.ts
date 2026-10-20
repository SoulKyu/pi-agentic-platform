import {
  appendFileSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionAppend, SESSION_CHUNK_BYTES } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionMirror, openUnderRoot } from "./session-mirror.ts";

// Security file: the mutants and the case that kills each one.
// - open without O_NOFOLLOW at every component (openUnderRoot -> plain openSync): "refuses a link as the file and as a folder".
// - drop the replace flag on the first chunk of a resend: "resends from 0 with replace on the first chunk only".
// - take a matching offset without reading the entry id: "resumes from the offset when the entry ending there matches".
// - skip the inode check (size only): "resends everything when the file was replaced by a bigger one".
// - ignore a refused send (advance anyway): "keeps the rest when a send is refused".

let dir: string;
let file: string;
let sent: SessionAppend[];
let accept: boolean;
let logged: string[];
let timers: Array<{ at: number; fn: () => void }>;
let now: number;

const clock = {
  setTimeout: (fn: () => void, ms: number) => {
    const timer = { at: now + ms, fn };
    timers.push(timer);
    return timer;
  },
  clearTimeout: (handle: unknown) => {
    timers = timers.filter((timer) => timer !== handle);
  },
};
const advance = (ms: number): void => {
  now += ms;
  for (const due of timers.filter((timer) => timer.at <= now)) {
    timers = timers.filter((timer) => timer !== due);
    due.fn();
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-mirror-"));
  file = join(dir, "s.jsonl");
  sent = [];
  accept = true;
  logged = [];
  timers = [];
  now = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (path: string): number => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
const make = (
  options: { path?: () => string | null; open?: (path: string) => number } = {},
): ReturnType<typeof createSessionMirror> =>
  createSessionMirror({
    file: options.path ?? (() => file),
    send: (record) => {
      if (!accept) return false;
      sent.push(record);
      return true;
    },
    open: options.open ?? open,
    clock,
    log: (line) => void logged.push(line),
  });
const bytesOf = (records: SessionAppend[]): Buffer =>
  Buffer.concat(records.map((record) => Buffer.from(record.data, "base64")));
const line = (id: string): string => `${JSON.stringify({ type: "message", id, parentId: null })}\n`;

describe("session mirror, worker half", () => {
  it("sends the bytes from the last sent offset in chunks of at most SESSION_CHUNK_BYTES, naming the file", () => {
    const content = Buffer.alloc(2 * SESSION_CHUNK_BYTES + 10, "a");
    writeFileSync(file, content);
    make().flush();
    expect(sent.map((record) => record.offset)).toEqual([0, SESSION_CHUNK_BYTES, 2 * SESSION_CHUNK_BYTES]);
    expect(sent.map((record) => Buffer.from(record.data, "base64").length)).toEqual([
      SESSION_CHUNK_BYTES,
      SESSION_CHUNK_BYTES,
      10,
    ]);
    expect(new Set(sent.map((record) => record.file))).toEqual(new Set(["s.jsonl"]));
    expect(sent.every((record) => !record.replace)).toBe(true);
    expect(bytesOf(sent).equals(content)).toBe(true);
  });

  it("sends nothing while the file has not grown and only the new bytes after it did", () => {
    writeFileSync(file, line("a"));
    const mirror = make();
    mirror.flush();
    mirror.flush();
    expect(sent).toHaveLength(1);
    appendFileSync(file, line("b"));
    mirror.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.offset).toBe(Buffer.byteLength(line("a")));
    expect(Buffer.from(sent[1]?.data ?? "", "base64").toString()).toBe(line("b"));
    expect(timers).toHaveLength(0);
  });

  it("sends nothing for a missing file, a null file and an empty one", () => {
    make().flush();
    make({ path: () => null }).flush();
    writeFileSync(file, "");
    make().flush();
    expect(sent).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("sends an append that came with no walk at the next flush, as a command response triggers", () => {
    writeFileSync(file, line("a"));
    const mirror = make();
    mirror.flush();
    appendFileSync(file, line("renamed"));
    expect(sent).toHaveLength(1);
    mirror.flush();
    expect(sent).toHaveLength(2);
  });

  // Mutant: advance the offset although send returned false -> the lost bytes are never sent (killed here).
  it("keeps the rest when a send is refused and sends it from the 2 s timer", () => {
    writeFileSync(file, line("a"));
    accept = false;
    const mirror = make();
    mirror.flush();
    expect(sent).toEqual([]);
    expect(timers.map((timer) => timer.at)).toEqual([2000]);
    mirror.flush();
    expect(timers).toHaveLength(1);
    accept = true;
    advance(1999);
    expect(sent).toEqual([]);
    advance(1);
    expect(bytesOf(sent).toString()).toBe(line("a"));
    expect(sent[0]?.offset).toBe(0);
    expect(timers).toHaveLength(0);
  });

  it("sends what is left when it closes and then does nothing more", () => {
    writeFileSync(file, line("a"));
    accept = false;
    const mirror = make();
    mirror.flush();
    accept = true;
    mirror.close();
    expect(bytesOf(sent).toString()).toBe(line("a"));
    expect(timers).toHaveLength(0);
    appendFileSync(file, line("b"));
    mirror.flush();
    expect(sent).toHaveLength(1);
  });

  // Mutant: resume without reading the entry id (offset only) -> the mismatch case sends no replace (killed here).
  describe("resync", () => {
    const body = (): { text: string; end: number } => {
      const text = line("a") + line("b") + line("c");
      return { text, end: Buffer.byteLength(line("a") + line("b")) };
    };

    it("resumes from the offset when the entry ending there matches", () => {
      const { text, end } = body();
      writeFileSync(file, text);
      const mirror = make();
      mirror.resync({ fromOffset: end, lastEntryId: "b" });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ offset: end, replace: false });
      expect(bytesOf(sent).toString()).toBe(line("c"));
    });

    it("sends nothing more when the mirror already holds the whole file", () => {
      const { text } = body();
      writeFileSync(file, text);
      make().resync({ fromOffset: Buffer.byteLength(text), lastEntryId: "c" });
      expect(sent).toEqual([]);
    });

    // Mutant: drop the replace flag of the first chunk -> the daemon appends a second copy (killed here).
    it("resends from 0 with replace on the first chunk only for a mismatch, offset 0 and unusable offsets", () => {
      const big = Buffer.concat([Buffer.from(line("a") + line("b")), Buffer.alloc(SESSION_CHUNK_BYTES, "x")]);
      writeFileSync(file, big);
      const end = Buffer.byteLength(line("a") + line("b"));
      const cases = [
        { fromOffset: end, lastEntryId: "zzz" },
        { fromOffset: end, lastEntryId: null },
        { fromOffset: 0, lastEntryId: "b" },
        { fromOffset: end - 3, lastEntryId: "b" },
        { fromOffset: big.length + 5, lastEntryId: "b" },
      ];
      for (const request of cases) {
        sent = [];
        make().resync(request);
        expect(
          sent.map((record) => [record.offset, record.replace]),
          JSON.stringify(request),
        ).toEqual([
          [0, true],
          [SESSION_CHUNK_BYTES, false],
        ]);
        expect(bytesOf(sent).equals(big)).toBe(true);
      }
    });

    it("treats a last line that is not JSON as a mismatch", () => {
      writeFileSync(file, "not json\n");
      make().resync({ fromOffset: 9, lastEntryId: "a" });
      expect(sent[0]).toMatchObject({ offset: 0, replace: true });
    });
  });

  // Mutant: skip the size and inode checks -> Pi's rewrite is appended after stale bytes (killed here).
  it("resends everything with replace when the file shrank", () => {
    writeFileSync(file, line("a") + line("b"));
    const mirror = make();
    mirror.flush();
    sent = [];
    writeFileSync(file, line("c"));
    mirror.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ offset: 0, replace: true });
    expect(bytesOf(sent).toString()).toBe(line("c"));
    sent = [];
    appendFileSync(file, line("d"));
    mirror.flush();
    expect(sent[0]).toMatchObject({ offset: Buffer.byteLength(line("c")), replace: false });
  });

  it("resends everything when the file was replaced by a bigger one", () => {
    writeFileSync(file, line("a"));
    const mirror = make();
    mirror.flush();
    sent = [];
    writeFileSync(join(dir, "other"), line("x") + line("y") + line("z"));
    renameSync(join(dir, "other"), file);
    mirror.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ offset: 0, replace: true });
    expect(bytesOf(sent).toString()).toBe(line("x") + line("y") + line("z"));
  });

  it("sends an empty replace when the file was emptied", () => {
    writeFileSync(file, line("a"));
    const mirror = make();
    mirror.flush();
    sent = [];
    truncateSync(file, 0);
    mirror.flush();
    expect(sent).toEqual([{ type: "session_append", file: "s.jsonl", offset: 0, data: "", replace: true }]);
  });

  it("starts at 0 without replace when Pi moves to another session file", () => {
    writeFileSync(file, line("a"));
    let path = file;
    const mirror = make({ path: () => path });
    mirror.flush();
    sent = [];
    path = join(dir, "t.jsonl");
    writeFileSync(path, line("b"));
    mirror.flush();
    expect(sent).toEqual([
      {
        type: "session_append",
        file: "t.jsonl",
        offset: 0,
        data: Buffer.from(line("b")).toString("base64"),
        replace: false,
      },
    ]);
  });

  // Mutant: open with a plain openSync, or follow a link at a middle component -> the target is read and sent.
  it("refuses a link as the file and as a folder, sends nothing and logs the error", () => {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "secret.jsonl"), "SECRET\n");
    symlinkSync(join(dir, "real", "secret.jsonl"), file);
    symlinkSync(join(dir, "real"), join(dir, "folder"));
    const walker = openUnderRoot(dir);
    make({ open: walker }).flush();
    make({ open: walker, path: () => join(dir, "folder", "secret.jsonl") }).flush();
    make({ open: open }).flush();
    expect(sent).toEqual([]);
    expect(logged).toHaveLength(3);
    expect(logged.join("")).not.toContain("SECRET");
  });

  it("opens through the walker for a plain file below the root and refuses one outside it", () => {
    writeFileSync(file, line("a"));
    const fd = openUnderRoot(dir)(file);
    closeSync(fd);
    expect(() => openUnderRoot(join(dir, "sub"))(file)).toThrow();
  });

  it("does not repeat the same log line on every flush", () => {
    symlinkSync(join(dir, "nowhere"), file);
    const mirror = make();
    mirror.flush();
    mirror.flush();
    expect(logged).toHaveLength(1);
  });
});
