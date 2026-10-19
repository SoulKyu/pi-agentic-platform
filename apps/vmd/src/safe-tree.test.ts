import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTreeSafely } from "./safe-tree.ts";

/*
 * Mutants (RT-43), each run for real against this file and killed here:
 *  - M-unbounded: the byte budget is not applied while reading (the read is `CHUNK` wide and nothing throws `too_large`):
 *    killed by "the 1001st byte" and "a file a concurrent writer keeps growing" (safe-tree.race.test.ts).
 *  - M-stat: `statSync` in place of `lstatSync` for an entry: a link looks like a file or folder, so it is opened with
 *    O_NOFOLLOW and the copy stops `changed`: killed by "links are recreated as links".
 *  - M-root-follow: O_NOFOLLOW dropped from the source's own open: killed by "a link at the root".
 *  - M-open-follow: O_NOFOLLOW dropped from an entry's open (a link swapped in after the look): killed in
 *    safe-tree.race.test.ts.
 */
const uid = process.getuid?.() ?? -1;
const limits = { maxBytes: 1_000_000, maxEntries: 1000 };
const umask = process.umask();
let work: string;
let source: string;
let target: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "vmd-safe-tree-"));
  source = path.join(work, "source");
  target = path.join(work, "target");
  mkdirSync(source);
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const mode = (file: string): number => lstatSync(file).mode & 0o7777;

describe("copyTreeSafely", () => {
  it("links are recreated as links, never followed (a relative one and an absolute one three levels down)", () => {
    mkdirSync(path.join(source, "node_modules/.bin"), { recursive: true });
    writeFileSync(path.join(source, "node_modules/tool.js"), "console.log(1)");
    symlinkSync("../tool.js", path.join(source, "node_modules/.bin/tool"));
    mkdirSync(path.join(source, "a/b/c"), { recursive: true });
    symlinkSync("/etc/passwd", path.join(source, "a/b/c/abs"));
    symlinkSync("dangling-nowhere", path.join(source, "dangling"));

    expect(copyTreeSafely(source, target, uid, limits)).toBeNull();

    const rel = path.join(target, "node_modules/.bin/tool");
    expect(lstatSync(rel).isSymbolicLink()).toBe(true);
    expect(readlinkSync(rel)).toBe("../tool.js");
    const abs = path.join(target, "a/b/c/abs");
    expect(lstatSync(abs).isSymbolicLink()).toBe(true);
    expect(readlinkSync(abs)).toBe("/etc/passwd");
    expect(readlinkSync(path.join(target, "dangling"))).toBe("dangling-nowhere");
    expect(readFileSync(path.join(target, "node_modules/tool.js"), "utf8")).toBe("console.log(1)");
  });

  it("a link to a folder of outside is a link in the copy, its content is not copied", () => {
    const outside = path.join(work, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret"), "s3cret");
    symlinkSync(outside, path.join(source, "out"));
    expect(copyTreeSafely(source, target, uid, limits)).toBeNull();
    expect(lstatSync(path.join(target, "out")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(target, "secret"))).toBe(false);
  });

  it("a setuid, setgid or sticky file is copied without those bits; executable bits give 0755, others 0644", () => {
    writeFileSync(path.join(source, "suid"), "x");
    chmodSync(path.join(source, "suid"), 0o4755);
    writeFileSync(path.join(source, "sgid"), "x");
    chmodSync(path.join(source, "sgid"), 0o2644);
    writeFileSync(path.join(source, "plain"), "x");
    chmodSync(path.join(source, "plain"), 0o600);
    mkdirSync(path.join(source, "sticky"));
    chmodSync(path.join(source, "sticky"), 0o1777);
    expect(copyTreeSafely(source, target, uid, limits)).toBeNull();
    expect(mode(path.join(target, "suid"))).toBe(0o755 & ~umask);
    expect(mode(path.join(target, "sgid"))).toBe(0o644 & ~umask);
    expect(mode(path.join(target, "plain"))).toBe(0o644 & ~umask);
    expect(mode(path.join(target, "sticky"))).toBe(0o755 & ~umask);
  });

  it("a hard link to an outside file of the same owner is copied as content (documented: the bytes were readable by that owner anyway)", () => {
    const outside = path.join(work, "outside-file");
    writeFileSync(outside, "same owner");
    linkSync(outside, path.join(source, "hard"));
    expect(copyTreeSafely(source, target, uid, limits)).toBeNull();
    const copied = path.join(target, "hard");
    expect(lstatSync(copied).isFile()).toBe(true);
    expect(lstatSync(copied).nlink).toBe(1);
    expect(readFileSync(copied, "utf8")).toBe("same owner");
  });

  it("a leftover target of an interrupted copy is replaced", () => {
    mkdirSync(path.join(target, "stale"), { recursive: true });
    writeFileSync(path.join(target, "stale/old"), "old");
    writeFileSync(path.join(target, "leftover"), "old");
    writeFileSync(path.join(source, "new"), "new");
    expect(copyTreeSafely(source, target, uid, limits)).toBeNull();
    expect(existsSync(path.join(target, "stale"))).toBe(false);
    expect(existsSync(path.join(target, "leftover"))).toBe(false);
    expect(readFileSync(path.join(target, "new"), "utf8")).toBe("new");
  });

  it("a link at the root answers `link` and creates nothing", () => {
    const real = path.join(work, "real");
    mkdirSync(real);
    writeFileSync(path.join(real, "f"), "x");
    const root = path.join(work, "root-link");
    symlinkSync(real, root);
    expect(copyTreeSafely(root, target, uid, limits)).toBe("link");
    expect(existsSync(target)).toBe(false);
  });

  it("a missing source answers `missing`", () => {
    expect(copyTreeSafely(path.join(work, "nope"), target, uid, limits)).toBe("missing");
    expect(existsSync(target)).toBe(false);
  });

  it("a FIFO answers `special` without blocking and the partial target is removed", () => {
    writeFileSync(path.join(source, "a-file"), "x");
    execFileSync("mkfifo", [path.join(source, "pipe")]);
    expect(copyTreeSafely(source, target, uid, limits)).toBe("special");
    expect(existsSync(target)).toBe(false);
  });

  it("an entry of another uid answers `owner`, the root folder included", () => {
    writeFileSync(path.join(source, "f"), "x");
    expect(copyTreeSafely(source, target, uid + 1, limits)).toBe("owner");
    expect(existsSync(target)).toBe(false);
  });

  it("the 12th entry over a cap of 11 answers `too_many`; 11 is fine; entries of nested folders count", () => {
    for (let i = 0; i < 11; i += 1) writeFileSync(path.join(source, `f${i}`), "x");
    expect(copyTreeSafely(source, target, uid, { maxBytes: 100, maxEntries: 11 })).toBeNull();
    writeFileSync(path.join(source, "f11"), "x");
    expect(copyTreeSafely(source, target, uid, { maxBytes: 100, maxEntries: 11 })).toBe("too_many");
    expect(existsSync(target)).toBe(false);
    rmSync(path.join(source, "f11"));
    rmSync(path.join(source, "f10"));
    mkdirSync(path.join(source, "d"));
    writeFileSync(path.join(source, "d/a"), "x");
    writeFileSync(path.join(source, "d/b"), "x");
    expect(copyTreeSafely(source, target, uid, { maxBytes: 100, maxEntries: 11 })).toBe("too_many");
  });

  it("the 1001st byte over a cap of 1000 answers `too_large`; 1000 is fine; the budget is shared by all files", () => {
    writeFileSync(path.join(source, "big"), Buffer.alloc(1000, 1));
    expect(copyTreeSafely(source, target, uid, { maxBytes: 1000, maxEntries: 10 })).toBeNull();
    expect(readFileSync(path.join(target, "big")).length).toBe(1000);
    writeFileSync(path.join(source, "big"), Buffer.alloc(1001, 1));
    expect(copyTreeSafely(source, target, uid, { maxBytes: 1000, maxEntries: 10 })).toBe("too_large");
    expect(existsSync(target)).toBe(false);
    writeFileSync(path.join(source, "big"), Buffer.alloc(600, 1));
    writeFileSync(path.join(source, "more"), Buffer.alloc(401, 1));
    expect(copyTreeSafely(source, target, uid, { maxBytes: 1000, maxEntries: 10 })).toBe("too_large");
    expect(existsSync(target)).toBe(false);
  });

  it("an empty file and an empty folder are copied", () => {
    writeFileSync(path.join(source, "empty"), "");
    mkdirSync(path.join(source, "dir"));
    expect(copyTreeSafely(source, target, uid, { maxBytes: 0, maxEntries: 10 })).toBeNull();
    expect(lstatSync(path.join(target, "empty")).size).toBe(0);
    expect(lstatSync(path.join(target, "dir")).isDirectory()).toBe(true);
  });
});
