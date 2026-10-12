import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore, type SearchIndexStore } from "./index-store.ts";
import { processFile } from "./scanner-file.ts";
import { HEAD_CHARS, HEADER_MAX_BYTES } from "./session-file.ts";
import type { FakeScanPort } from "./testing/fake-scan-port.ts";
import { header, info, piFile, useScannerBed, user } from "./testing/scanner-bed.ts";

const bed = useScannerBed({ openSearchIndex, createSearchIndexStore, processFile });
const { context, file, said, run } = bed;
let sessionsDir = "";
let store: SearchIndexStore;
let port: FakeScanPort;
beforeEach(() => {
  ({ sessionsDir, store, port } = bed);
});

describe("failures stay inside the file (RT-04)", () => {
  it("contains a SQLite error from the store, says its code only, leaves the cursor alone", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    const broken: SearchIndexStore = {
      ...store,
      commit: () => {
        throw Object.assign(new Error(`disk image is malformed ${path}`), { code: "ERR_SQLITE_ERROR" });
      },
    };
    expect(processFile(path, context(undefined, { store: broken }))).toEqual({
      kind: "skipped",
      reason: "ERR_SQLITE_ERROR",
    });
    expect(said("session_file_unreadable").map((w) => w.fields)).toEqual([{ code: "ERR_SQLITE_ERROR" }]);
    expect(store.cursor(path)).toBeUndefined();
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 1 });
  });

  it("contains a read error (a directory named like a session)", () => {
    const path = join(sessionsDir, "dir.jsonl");
    mkdirSync(path);
    expect(run(path)).toEqual({ kind: "skipped", reason: "not_file" });
  });

  it("contains an error thrown by the claim", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    const sessions = {
      ...port.port,
      claim: () => {
        throw Object.assign(new Error("boom"), { code: "EIO" });
      },
    };
    expect(processFile(path, context(undefined, { sessions }))).toEqual({ kind: "skipped", reason: "EIO" });
    expect(store.cursor(path)).toBeUndefined();
  });

  it("keeps indexing when a port call after the commit fails", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one"), info("Name")));
    const sessions = {
      ...port.port,
      named: () => {
        throw new Error("secret text");
      },
    };
    expect(processFile(path, context(undefined, { sessions }))).toMatchObject({ kind: "indexed", rows: 1 });
    expect(store.rowCount()).toBe(1);
    expect(said("session_file_port_failed").map((w) => w.fields)).toEqual([{ call: "named", code: "error" }]);
    expect(port.previewed).toHaveLength(1);
    expect(port.touched).toHaveLength(1);
  });
});

describe("fix round 1", () => {
  it("keeps the cursor head whole when a non-BMP character sits on unit 511: an append is read incrementally", () => {
    const withPad = (n: number): string =>
      JSON.stringify({ ...JSON.parse(header()), pad: `${"p".repeat(n)}\u{1F600}` });
    let n = 0;
    while (withPad(n).charCodeAt(HEAD_CHARS - 1) !== 0xd83d) n++;
    const real = withPad(n);
    const path = file("a.jsonl", piFile(real, user("e1", "one")));
    run(path);
    appendFileSync(path, `${user("e2", "two")}\n`);
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 1 });
    expect(store.rowCount()).toBe(2);
    expect(port.claims).toHaveLength(1);
  });

  it("counts activity only for entries read on from a stored cursor", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    expect(port.touched.map((t) => t.active)).toEqual([false]);
    appendFileSync(path, `${user("e2", "two")}\n`);
    run(path);
    expect(port.touched.map((t) => t.active)).toEqual([false, true]);
    store.forget(path); // an index rebuild or a forget: the cursor is gone, the file is read again
    run(path);
    expect(port.touched.map((t) => t.active)).toEqual([false, true, false]);
    writeFileSync(path, piFile(header("other"), user("f1", "uno"), user("f2", "dos"), user("f3", "tres")));
    run(path); // a rewrite resets the cursor
    expect(port.touched.map((t) => t.active)).toEqual([false, true, false, false]);
  });

  it("keeps the rows of a file that is transiently unreadable, forgets them when it is replaced by a link", (t) => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    chmodSync(path, 0o000);
    try {
      const outcome = run(path);
      if (outcome.kind === "indexed") {
        t.skip(); // running as a user that ignores permissions
        return;
      }
      expect(outcome).toEqual({ kind: "skipped", reason: "EACCES" });
      expect(store.rowCount()).toBe(1);
      expect(store.cursor(path)?.state).toBe("indexed");
      expect(said("session_file_unreadable").map((w) => w.fields)).toEqual([{ code: "EACCES" }]);
    } finally {
      chmodSync(path, 0o644);
    }
    rmSync(path);
    symlinkSync(file("real.jsonl", "x\n"), path);
    expect(run(path)).toEqual({ kind: "skipped", reason: "ELOOP" });
    expect(store.rowCount()).toBe(0);
  });

  it("stops indexing rows at the cap and says it only on the transition", () => {
    const events: string[] = [];
    const say = (event: string) => {
      events.push(event);
    };
    const limits = { maxIndexedChars: 20 };
    const path = file("a.jsonl", piFile(header(), user("e1", "a".repeat(15)), user("e2", "b".repeat(15))));
    processFile(path, context(limits, { say }));
    appendFileSync(path, `${user("e3", "c")}\n`);
    processFile(path, context(limits, { say }));
    appendFileSync(path, `${user("e4", "d")}\n`);
    processFile(path, context(limits, { say }));
    expect(events).toEqual(["session_file_capped"]);
    expect(store.rowCount()).toBe(1);
  });

  it("marks a file with no newline in its first 64 KiB as bad, once", () => {
    const path = file("a.jsonl", "x".repeat(HEADER_MAX_BYTES));
    expect(run(path)).toEqual({ kind: "skipped", reason: "bad_header" });
    expect(store.cursor(path)?.state).toBe("bad");
    expect(run(path)).toEqual({ kind: "skipped", reason: "bad_header" });
    expect(said("session_file_bad_header")).toHaveLength(1);
  });

  it("re-reads a file replaced by rename with the same header", () => {
    const path = file("a.jsonl", piFile(header(), user("e1", "one")));
    run(path);
    const next = file(
      "next.jsonl",
      piFile(header(), user("g1", "uno"), user("g2", "dos"), user("g3", "tres")),
    );
    renameSync(next, path);
    expect(run(path)).toMatchObject({ kind: "indexed", rows: 3 });
    expect(store.rowCount()).toBe(3);
    expect(port.claims).toHaveLength(2);
  });

  it("does not read an excluded file again while its inode, size and mtime are unchanged", () => {
    const text = piFile(header("old", "2026-10-11T23:59:59.000Z"), user("e1", "old"));
    const path = file("old.jsonl", text);
    run(path);
    // Same cursor, now a post-install header: only the shortcut can still answer "excluded".
    writeFileSync(path, text.replace("2026-10-11T23:59:59", "2026-10-12T23:59:59"));
    const stat = statSync(path);
    const cursor = store.cursor(path);
    if (!cursor) throw new Error("no cursor");
    store.commit({ ...cursor, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }, []);
    expect(run(path)).toEqual({ kind: "skipped", reason: "excluded" });
    expect(port.claims).toHaveLength(0);
  });

  it("counts no activity for the later steps of a multi-step read, only for a file that grew", () => {
    const entries = Array.from({ length: 10 }, (_, i) => user(`e${i}`, `message ${i} ${"x".repeat(150)}`));
    const path = file("a.jsonl", piFile(header(), ...entries));
    const limits = { stepBytes: 300 };
    const drain = (): void => {
      for (let i = 0; i < 20; i++) {
        const outcome = run(path, limits);
        if (outcome.kind !== "indexed" || !outcome.more) return;
      }
      throw new Error("did not finish");
    };
    drain();
    expect(port.touched.length).toBeGreaterThan(1);
    expect(port.touched.every((t) => !t.active)).toBe(true);
    store.forget(path);
    port.touched.length = 0;
    drain();
    expect(port.touched.length).toBeGreaterThan(1);
    expect(port.touched.every((t) => !t.active)).toBe(true);
    port.touched.length = 0;
    appendFileSync(path, `${user("e10", "new")}\n`);
    run(path, limits);
    expect(port.touched.map((t) => t.active)).toEqual([true]);
  });

  it("says the cap when a file filled exactly to the budget drops a later row", () => {
    const events: string[] = [];
    const say = (event: string) => {
      events.push(event);
    };
    const limits = { maxIndexedChars: 20 };
    const path = file("a.jsonl", piFile(header(), user("e1", "a".repeat(20))));
    processFile(path, context(limits, { say }));
    expect(events).toEqual([]);
    appendFileSync(path, `${user("e2", "b")}\n`);
    processFile(path, context(limits, { say }));
    appendFileSync(path, `${user("e3", "c")}\n`);
    processFile(path, context(limits, { say }));
    expect(events).toEqual(["session_file_capped"]);
    expect(store.rowCount()).toBe(1);
  });
});
