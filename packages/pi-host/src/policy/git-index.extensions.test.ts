import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheTree,
  endOfEntries,
  entryV2,
  entryV4,
  extension,
  FILE,
  fsmonitor,
  GIT_ENV,
  GITLINK,
  header,
  lsFiles,
  offsetTable,
  resolveUndo,
  seal,
  threadedGitlink,
  untrackedCache,
  varintBytes,
} from "./git-index.fixtures.ts";
import { indexVerdict } from "./git-index.ts";

/**
 * M7 ruling MC11 (a): index extensions are an allowlist of those that never change which entries git loads, walked as
 * git walks them; and entries git refuses to load are refused too (MC7: stricter than git, never different).
 */

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-git-index-ext-")));
  execFileSync("git", ["init", "-q"], { cwd: dir, env: GIT_ENV(dir), stdio: "pipe" });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** git's own reading of `bytes` as this repository's index, without and with the threaded load. */
function gitReads(bytes: Buffer): ReturnType<typeof lsFiles>[] {
  writeFileSync(join(dir, ".git", "index"), bytes);
  return [lsFiles(dir, dir, false), lsFiles(dir, dir, true)];
}
const withFile = (...extensions: Buffer[]): Buffer =>
  seal(Buffer.concat([header(2, 1), entryV2("a"), ...extensions]));

describe("the extensions that never change which entries git loads", () => {
  it.each([
    ["TREE", cacheTree()],
    ["REUC", resolveUndo("a")],
    ["FSMN", fsmonitor(1, 1)],
  ])("reads %s, as git does", (_, ext) => {
    const bytes = withFile(ext);
    expect(indexVerdict(bytes)).toBe("clean");
    expect(gitReads(bytes).map(({ ok, gitlinks, stderr }) => [ok, gitlinks, stderr])).toEqual([
      [true, 0, ""],
      [true, 0, ""],
    ]);
  });
  it("reads all three in a row, and still finds a gitlink among the entries", () => {
    const tail = [cacheTree(), resolveUndo("a"), fsmonitor(1)];
    expect(indexVerdict(withFile(...tail))).toBe("clean");
    const linked = seal(Buffer.concat([header(2, 2), entryV2("a"), entryV2("sub", GITLINK), ...tail]));
    expect(indexVerdict(linked)).toBe("gitlink");
  });
});

describe("the untracked cache (UNTR) asks: git's reader writes out of bounds on a crafted one", () => {
  it("asks for one git reads well", () => {
    for (const ext of [untrackedCache(), untrackedCache({ declared: 4, actual: 4 })]) {
      expect(gitReads(withFile(ext)).map(({ ok, stderr }) => [ok, stderr])).toEqual([
        [true, ""],
        [true, ""],
      ]);
      expect(indexVerdict(withFile(ext))).toBe("unreadable");
    }
  });
  it("asks for more directories than declared (git aborts: double free or corruption; not run here)", () => {
    expect(indexVerdict(withFile(untrackedCache({ declared: 1, actual: 4 })))).toBe("unreadable");
  });
  it("asks for the untracked cache git writes (core.untrackedCache)", () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const cached = ["-c", "core.untrackedCache=true"];
    for (const args of [
      ["add", "a.txt"],
      [...cached, "update-index", "--untracked-cache"],
      [...cached, "status"],
    ])
      execFileSync("git", args, { cwd: dir, env: GIT_ENV(dir), stdio: "pipe" });
    const bytes = readFileSync(join(dir, ".git", "index"));
    expect(bytes.includes("UNTR")).toBe(true);
    expect(indexVerdict(bytes)).toBe("unreadable");
  });
});

describe("any other extension asks", () => {
  it.each(["EOIE", "IEOT", "link", "sdir", "ZZZZ", "zzzz", "tree", "\0\0\0\0", "TREX"])(
    "asks for %j",
    (name) => {
      expect(indexVerdict(withFile(extension(name, 24)))).toBe("unreadable");
      expect(indexVerdict(withFile(cacheTree(), extension(name, 0)))).toBe("unreadable");
    },
  );
  it("asks for an index git wrote with index.threads (EOIE and IEOT)", () => {
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    const threads = ["-c", "index.threads=2", "-c", "index.recordOffsetTable=true"];
    execFileSync("git", [...threads, "-c", "index.recordEndOfIndexEntries=true", "add", "a.txt", "b.txt"], {
      cwd: dir,
      env: GIT_ENV(dir),
      stdio: "pipe",
    });
    const bytes = readFileSync(join(dir, ".git", "index"));
    expect([bytes.includes("IEOT"), bytes.toString("latin1", bytes.length - 52, bytes.length - 48)]).toEqual([
      true,
      "EOIE",
    ]);
    expect(indexVerdict(bytes)).toBe("unreadable");
  });
});

describe("extension headers are walked as git walks them", () => {
  it("reads an extension that ends exactly at the trailer, and asks for one that runs past it", () => {
    expect(indexVerdict(withFile(extension("TREE", 5)))).toBe("clean");
    const overrun = extension("TREE", 5);
    overrun.writeUInt32BE(6, 4);
    expect(indexVerdict(withFile(overrun))).toBe("unreadable");
  });
  it.each([1, 4, 7])("asks for %i bytes left before the trailer, too few for a header", (left) => {
    expect(indexVerdict(withFile(cacheTree(), Buffer.alloc(left)))).toBe("unreadable");
  });
});

describe("git's threaded load (review round 3, NEW-3)", () => {
  it.each([
    [2, false],
    [3, false],
    [4, false],
    [2, true],
    [3, true],
    [4, true],
  ] as const)(
    "version %i, EOIE hidden in TREE: %s: git loads the hidden gitlink, the reader asks",
    (version, hide) => {
      const bytes = threadedGitlink(version, hide);
      expect(gitReads(bytes).map(({ ok, gitlinks }) => [ok, gitlinks])).toEqual([
        [true, 0],
        [true, 1],
      ]);
      expect(indexVerdict(bytes)).toBe("unreadable");
    },
  );
  it("asks for EOIE at git's fixed place with no IEOT: git then walks the extensions from where EOIE says", () => {
    // Inside TREE: an extension header, then EOIE naming it. Threaded git walks from there and meets ZZZZ;
    // sequential git sees TREE alone (and drops it as an invalid cache tree).
    const inner = extension("ZZZZ", 0);
    const bytes = withFile(extension("TREE", Buffer.concat([inner, endOfEntries(12 + 64 + 8, [inner])])));
    expect(gitReads(bytes).map(({ ok, stderr }) => [ok, stderr.trim()])).toEqual([
      [true, ""],
      [true, "ignoring ZZZZ extension"],
    ]);
    expect(indexVerdict(bytes)).toBe("unreadable");
  });
  it("asks for the bytes EOIE at that place, whatever holds them", () => {
    const payload = Buffer.alloc(40);
    payload.write("EOIE", 8, "latin1");
    expect(indexVerdict(withFile(extension("TREE", payload)))).toBe("unreadable");
    payload.write("EOIX", 8, "latin1");
    expect(indexVerdict(withFile(extension("TREE", payload)))).toBe("clean");
  });
  it("asks for an IEOT whose blocks follow the entries exactly (git's own layout)", () => {
    const first = 12 + 64;
    const table = offsetTable([[12, 1]]);
    expect(indexVerdict(withFile(table, endOfEntries(first, [table])))).toBe("unreadable");
  });
});

describe("entries git refuses to load ask", () => {
  it.each([0x4000, 0x2000, 0x6000])("reads the extended flags git knows (%i)", (word) => {
    const bytes = seal(Buffer.concat([header(3, 1), entryV2("a", FILE, { extendedWord: word })]));
    expect(indexVerdict(bytes)).toBe("clean");
    expect(gitReads(bytes).map(({ ok }) => ok)).toEqual([true, true]);
  });
  it.each([0x1000, 0x8000, 0x0001, 0x7fff])(
    "asks for unknown extended flags (%i), which git dies on",
    (word) => {
      const v3 = seal(Buffer.concat([header(3, 1), entryV2("a", FILE, { extendedWord: word })]));
      const v4 = seal(
        Buffer.concat([header(4, 1), entryV4(varintBytes(0), "a", 1, FILE, { extendedWord: word })]),
      );
      expect([indexVerdict(v3), indexVerdict(v4)]).toEqual(["unreadable", "unreadable"]);
      expect(
        gitReads(v3).map(({ ok, stderr }) => [ok, stderr.startsWith("fatal: unknown index entry format")]),
      ).toEqual([
        [false, true],
        [false, true],
      ]);
    },
  );
});

describe("FSMN is read as git reads it (git aborts or runs out of memory on the rest; it is not run on those)", () => {
  /** Version 1: an 8-byte timestamp instead of the token. */
  function versionOne(bitSize: number): Buffer {
    const ext = fsmonitor(bitSize);
    const token = ext.indexOf(0, 12);
    const payload = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.alloc(8), ext.subarray(token + 1)]);
    return extension("FSMN", payload);
  }
  it("reads a bitmap of at most as many bits as entries, version 2 or 1", () => {
    expect(indexVerdict(withFile(fsmonitor(0)))).toBe("clean");
    expect(indexVerdict(withFile(fsmonitor(1, 2)))).toBe("clean");
    expect(indexVerdict(withFile(versionOne(1)))).toBe("clean");
    expect(gitReads(withFile(versionOne(1))).map(({ ok, stderr }) => [ok, stderr])).toEqual([
      [true, ""],
      [true, ""],
    ]);
  });
  it("asks for more bits than entries (git: BUG, fsmonitor_dirty has more entries than the index)", () => {
    expect(indexVerdict(withFile(fsmonitor(2)))).toBe("unreadable");
    expect(indexVerdict(withFile(versionOne(2)))).toBe("unreadable");
  });
  it("asks for a word count the bitmap does not hold (git allocates it before checking)", () => {
    const ext = fsmonitor(1, 1);
    const words = ext.length - 4 - 8 - 4;
    ext.writeUInt32BE(0x10000000, words);
    expect(indexVerdict(withFile(ext))).toBe("unreadable");
  });
  it("asks for another version, a token without its NUL, a bitmap size that disagrees, or a short payload", () => {
    const other = fsmonitor(1);
    other.writeUInt32BE(3, 8);
    const unterminated = extension("FSMN", Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("token")]));
    const size = fsmonitor(1);
    size.writeUInt32BE(size.readUInt32BE(18) + 8, 18);
    const short = extension("FSMN", Buffer.from([0, 0, 0, 2, 0]));
    for (const ext of [other, unterminated, size, short])
      expect(indexVerdict(withFile(ext))).toBe("unreadable");
  });
});
