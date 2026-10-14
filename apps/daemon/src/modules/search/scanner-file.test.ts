import { execFileSync } from "node:child_process";
import { appendFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../kernel/db/database.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore, type SearchIndexStore } from "./index-store.ts";
import { processFile } from "./scanner-file.ts";
import { HEAD_CHARS } from "./session-file.ts";
import type { FakeScanPort } from "./testing/fake-scan-port.ts";
import { assistant, header, info, piFile, useScannerBed, user } from "./testing/scanner-bed.ts";

const bed = useScannerBed({ openSearchIndex, createSearchIndexStore, processFile });
const { file, said, run } = bed;
let sessionsDir = "";
let db: Db;
let store: SearchIndexStore;
let port: FakeScanPort;
beforeEach(() => {
  ({ sessionsDir, db, store, port } = bed);
});

describe("processFile", () => {
  it("indexes a new file after the install", () => {
    const path = file(
      "a.jsonl",
      piFile(header(), user("e1", "hello world"), assistant("e2", "hi there"), info("My name")),
    );
    const stat = statSync(path);
    expect(run(path)).toEqual({ kind: "indexed", sessionId: "s1", rows: 2, more: false });
    expect(store.rowCount()).toBe(2);
    expect(store.cursor(path)).toMatchObject({
      state: "indexed",
      offset: stat.size,
      sessionId: "s1",
      ownerId: "u1",
    });
    expect(port.claims).toEqual([
      {
        path,
        header: { id: "sess-1", cwd: "/w/api", createdAt: Date.parse("2026-10-12T10:00:00.000Z") },
      },
    ]);
    expect(port.touched).toEqual([{ sessionId: "s1", at: stat.mtimeMs, active: false, toolResults: false }]);
    expect(port.previewed).toEqual([{ sessionId: "s1", text: "hello world" }]);
    expect(port.named).toEqual([{ sessionId: "s1", raw: "My name" }]);
  });

  it("reads only what was appended", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one"), assistant("e2", "two")));
    run(path);
    appendFileSync(path, `${user("e3", "three")}\n`);
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 1 });
    expect(store.rowCount()).toBe(3);
    expect(port.claims).toHaveLength(1);
  });

  it("never indexes a torn last line, then indexes it once when completed", () => {
    const whole = `${header()}\n${user("e1", "one")}\n`;
    const torn = user("e2", "two");
    const path = file("a.jsonl", whole + torn.slice(0, 20));
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 1 });
    expect(store.cursor(path)?.offset).toBe(Buffer.byteLength(whole));
    appendFileSync(path, `${torn.slice(20)}\n`);
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 1 });
    expect(store.rowCount()).toBe(2);
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 0 });
    expect(store.rowCount()).toBe(2);
  });

  it("excludes a session created before the install: never claimed, not read again while unchanged", () => {
    const path = file("old.jsonl", piFile(header("old", "2026-10-11T23:59:59.000Z"), user("e1", "old news")));
    expect(run(path)).toEqual({ kind: "skipped", reason: "excluded" });
    expect(store.cursor(path)?.state).toBe("excluded");
    expect(run(path)).toEqual({ kind: "skipped", reason: "excluded" });
    expect(port.claims).toHaveLength(0);
    expect(store.rowCount()).toBe(0);
  });

  it("re-reads from the start a file rewritten in place", () => {
    const path = file("a.jsonl", piFile(header("first"), user("e1", "one"), user("e2", "two")));
    run(path);
    writeFileSync(path, piFile(header("second"), user("f1", "uno"), user("f2", "dos"), user("f3", "tres")));
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 3 });
    expect(store.rowCount()).toBe(3);
    expect(port.claims.map((c) => c.header.id)).toEqual(["first", "second"]);
  });

  it("re-reads a truncated file", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one"), user("e2", "two"), user("e3", "3")));
    run(path);
    writeFileSync(path, piFile(header(), user("g1", "only")));
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 1 });
    expect(store.rowCount()).toBe(1);
    expect(port.claims).toHaveLength(2);
  });

  it("refuses a FIFO without blocking", (t) => {
    const path = join(sessionsDir, "pipe.jsonl");
    try {
      execFileSync("mkfifo", [path]);
    } catch (error) {
      if (process.env.CI) throw error;
      console.warn("mkfifo is not available: FIFO test skipped");
      t.skip();
    }
    expect(run(path)).toEqual({ kind: "skipped", reason: "not_file" });
    expect(store.cursor(path)).toBeUndefined();
  });

  it("never follows a symlink", () => {
    const target = file("real.jsonl", piFile(header(), user("e1", "one")));
    const link = join(sessionsDir, "link.jsonl");
    symlinkSync(target, link);
    expect(run(link)).toEqual({ kind: "skipped", reason: "ELOOP" });
    expect(store.cursor(link)).toBeUndefined();
    expect(said("session_file_unreadable")).toHaveLength(0);
  });

  it("says a bad header once within the minute, whatever the files", () => {
    const bad = [
      file("b1.jsonl", "not json\n"),
      file("b2.jsonl", `${header("bad id")}\n`),
      file("b3.jsonl", `${JSON.stringify({ type: "message" })}\n`),
    ];
    for (const path of bad) {
      expect(run(path)).toEqual({ kind: "skipped", reason: "bad_header" });
      expect(store.cursor(path)?.state).toBe("bad");
    }
    expect(said("session_file_bad_header")).toHaveLength(1);
  });

  it("leaves a header still being written for later", () => {
    const path = file("a.jsonl", header());
    expect(run(path)).toEqual({ kind: "skipped", reason: "no_header_yet" });
    expect(store.cursor(path)).toBeUndefined();
  });

  it("waits for an owner, then indexes", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    port.answer({ kind: "wait" });
    expect(run(path)).toEqual({ kind: "waiting" });
    expect(store.cursor(path)?.state).toBe("waiting");
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 1 });
    expect(port.claims).toHaveLength(2);
  });

  it("skips a duplicate id and does not read it again while unchanged", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    port.answer({ kind: "skip", reason: "duplicate_id" });
    expect(run(path)).toEqual({ kind: "skipped", reason: "duplicate_id" });
    expect(store.cursor(path)?.state).toBe("bad");
    expect(run(path)).toEqual({ kind: "skipped", reason: "bad_header" });
    expect(port.claims).toHaveLength(1);
    expect(store.rowCount()).toBe(0);
  });

  it("caps the indexed text but keeps names and activity", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "a".repeat(15)), user("e2", "b".repeat(15))));
    expect(run(path, { maxIndexedChars: 20 })).toMatchObject({ rows: 1 });
    expect(store.cursor(path)?.indexedChars).toBe(21);
    expect(said("session_file_capped")).toHaveLength(1);
    appendFileSync(path, `${info("Later name")}\n`);
    run(path, { maxIndexedChars: 20 });
    expect(port.named).toEqual([{ sessionId: "s1", raw: "Later name" }]);
    expect(port.touched).toHaveLength(2);
    expect(store.rowCount()).toBe(1);
    appendFileSync(path, `${user("e3", "c".repeat(3))}\n`);
    run(path, { maxIndexedChars: 20 });
    expect(store.rowCount()).toBe(1);
    expect(said("session_file_capped")).toHaveLength(1);
  });

  it("goes on in steps until the file is read, every row once", () => {
    const entries = Array.from({ length: 10 }, (_, i) => user(`e${i}`, `message ${i} ${"x".repeat(150)}`));
    const path = file("a.jsonl", piFile(header(), ...entries));
    let calls = 0;
    let rows = 0;
    for (let outcome = run(path, { stepBytes: 300 }); ; outcome = run(path, { stepBytes: 300 })) {
      calls++;
      if (outcome.kind !== "indexed") throw new Error(`unexpected ${outcome.kind}`);
      rows += outcome.rows;
      if (!outcome.more) break;
      expect(calls).toBeLessThan(20);
    }
    expect(calls).toBe(5);
    expect(rows).toBe(10);
    expect(store.rowCount()).toBe(10);
    expect(store.cursor(path)?.offset).toBe(statSync(path).size);
  });

  it("forgets a deleted file", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    rmSync(path);
    expect(run(path)).toEqual({ kind: "gone" });
    expect(store.cursor(path)).toBeUndefined();
    expect(store.rowCount()).toBe(0);
  });

  it("never lets the snippet markers reach the index", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "a\u0002b\u0003c")));
    run(path);
    expect(db.get<{ text: string }>("SELECT text FROM rows")?.text).toBe("a b c");
  });

  it("crosses a line over 8 MiB that is still being written, without reading it twice (RT-23)", () => {
    const opening = `${piFile(header(), user("e1", "first"))}`;
    const path = file("a.jsonl", opening);
    appendFileSync(path, Buffer.alloc(9 * 1024 * 1024, 0x78));
    const limits = { stepBytes: 300 };
    expect(run(path, limits)).toMatchObject({ kind: "indexed", rows: 1, more: true });
    expect(store.cursor(path)?.skipLine).toBe(true);
    let last = run(path, limits);
    for (let i = 0; last.kind === "indexed" && last.more; i++) {
      expect(i).toBeLessThan(40);
      last = run(path, limits);
    }
    expect(last).toMatchObject({ kind: "indexed", rows: 0, more: false });
    expect(store.cursor(path)).toMatchObject({ offset: statSync(path).size, skipLine: true });
    expect(said("session_file_lines_skipped")).toHaveLength(0);
    appendFileSync(path, `\n${user("e2", "second")}\n`);
    expect(run(path, limits)).toMatchObject({ kind: "indexed", rows: 1 });
    expect(said("session_file_lines_skipped").map((w) => w.fields)).toEqual([{ bad: 0, skipped: 1 }]);
    expect(store.cursor(path)?.skipLine).toBe(false);
    expect(store.rowCount()).toBe(2);
  });

  it("clips the first message and the name to HEAD_CHARS before the port", () => {
    const path = file(
      "a.jsonl",
      piFile(header(), user("e1", "u".repeat(HEAD_CHARS + 88)), info("n".repeat(HEAD_CHARS + 88))),
    );
    run(path);
    expect(port.previewed[0]?.text).toBe("u".repeat(HEAD_CHARS));
    expect(port.named[0]?.raw).toBe("n".repeat(HEAD_CHARS));
  });
});
