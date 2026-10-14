import { linkSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLineCounter } from "./line-counts.ts";
import { createVcsBed, type VcsBed } from "./testing/vcs-bed.ts";

let bed: VcsBed;
let dir: string;
beforeEach(() => {
  bed = createVcsBed();
  dir = bed.bb.proj;
});
afterEach(() => bed.dispose());

function counter(options: { cacheMax?: number; readsMax?: number } = {}) {
  const reads: string[] = [];
  const lines = createLineCounter({
    root: dir,
    scope: bed.scope([dir], "token"),
    deny: bed.deny,
    logger: bed.logger,
    read: async (handle: FileHandle, max: number) => {
      reads.push(String(max));
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(max), 0, max, 0);
      return buffer.subarray(0, bytesRead);
    },
    ...options,
  });
  return { lines, reads };
}
const put = (name: string, content: string | Buffer) => {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), content);
};

describe("counting lines", () => {
  it("counts newline-ended lines, a last line without one, and an empty file as zero", async () => {
    put("a.txt", "one\ntwo\n");
    put("b.txt", "one\ntwo");
    put("c.txt", "");
    put("d.txt", "\n\n\n");
    const { lines } = counter();
    lines.beginRun();
    expect(await Promise.all(["a.txt", "b.txt", "c.txt", "d.txt"].map((p) => lines.count(p)))).toEqual([
      { additions: 2, binary: false },
      { additions: 2, binary: false },
      { additions: 0, binary: false },
      { additions: 3, binary: false },
    ]);
  });

  it("calls a file with a NUL in its first 8 KiB binary and counts nothing", async () => {
    put("bin", Buffer.concat([Buffer.from("abc"), Buffer.from([0]), Buffer.from("def\n")]));
    const { lines } = counter();
    lines.beginRun();
    expect(await lines.count("bin")).toEqual({ additions: null, binary: true });
  });

  it("leaves a file over 400 KiB uncounted without reading it", async () => {
    put("big.txt", Buffer.alloc(400 * 1024 + 1, 0x61));
    put("edge.txt", Buffer.alloc(400 * 1024, 0x61));
    const { lines, reads } = counter();
    lines.beginRun();
    expect(await lines.count("big.txt")).toEqual({ additions: null, binary: false });
    expect(reads).toEqual([]);
    expect(await lines.count("edge.txt")).toEqual({ additions: 1, binary: false });
  });

  it("gives null for a link out of the root, a missing file and a folder", async () => {
    symlinkSync(join(bed.bb.outside, "secret.txt"), join(dir, "out"));
    mkdirSync(join(dir, "folder"));
    const { lines } = counter();
    lines.beginRun();
    for (const path of ["out", "missing", "folder"]) {
      expect(await lines.count(path), path).toEqual({ additions: null, binary: false });
    }
  });

  it("gives no count for a hard link to pap's database: the descriptor is checked, not only the name", async () => {
    linkSync(join(bed.bb.papHome, "state.db"), join(dir, "linked.db"));
    const { lines, reads } = counter();
    lines.beginRun();
    expect(await lines.count("linked.db")).toEqual({ additions: null, binary: false });
    expect(reads).toEqual([]);
  });

  it("gives a token no count for a file it may not open", async () => {
    put(".mcp.json", "{}\n");
    const { lines, reads } = counter();
    lines.beginRun();
    expect(await lines.count(".mcp.json")).toEqual({ additions: null, binary: false });
    expect(reads).toEqual([]);
  });
});

describe("the cache and the per-run budget", () => {
  it("reads an unchanged file once over three runs, and again when its size or mtime changes", async () => {
    put("a.txt", "one\n");
    const { lines, reads } = counter();
    for (let run = 0; run < 3; run += 1) {
      lines.beginRun();
      expect(await lines.count("a.txt")).toEqual({ additions: 1, binary: false });
    }
    expect(reads).toHaveLength(1);
    put("a.txt", "one\ntwo\n");
    lines.beginRun();
    expect(await lines.count("a.txt")).toEqual({ additions: 2, binary: false });
    expect(reads).toHaveLength(2);
    utimesSync(join(dir, "a.txt"), new Date(2020, 1, 1), new Date(2020, 1, 1));
    lines.beginRun();
    await lines.count("a.txt");
    expect(reads).toHaveLength(3);
  });

  it("reads at most 200 files per run and leaves the rest null until a later run", async () => {
    for (let i = 0; i < 201; i += 1) put(`f${String(i).padStart(3, "0")}.txt`, "x\n");
    const { lines, reads } = counter();
    const all = Array.from({ length: 201 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
    lines.beginRun();
    const first = [];
    for (const path of all) first.push(await lines.count(path));
    expect(first.filter((c) => c.additions === 1)).toHaveLength(200);
    expect(first.at(-1)).toEqual({ additions: null, binary: false });
    expect(reads).toHaveLength(200);
    lines.beginRun();
    expect(await lines.count(all[200] ?? "")).toEqual({ additions: 1, binary: false });
    expect(reads).toHaveLength(201);
  });

  it("keeps at most cacheMax entries, dropping the oldest", async () => {
    for (const name of ["a", "b", "c", "d"]) put(`${name}.txt`, "x\n");
    const { lines, reads } = counter({ cacheMax: 3 });
    lines.beginRun();
    for (const name of ["a", "b", "c", "d"]) await lines.count(`${name}.txt`);
    expect(reads).toHaveLength(4);
    lines.beginRun();
    for (const name of ["b", "c", "d"]) await lines.count(`${name}.txt`);
    expect(reads).toHaveLength(4);
    await lines.count("a.txt");
    expect(reads).toHaveLength(5);
  });
});
