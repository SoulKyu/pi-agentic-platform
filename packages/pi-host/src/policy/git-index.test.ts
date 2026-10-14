import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  entryV2,
  entryV4,
  extension,
  FILE,
  GITLINK,
  header,
  seal,
  varintBytes,
} from "./git-index.fixtures.ts";
import { indexVerdict, MAX_INDEX_ENTRIES } from "./git-index.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-git-index-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

/** A real index written by git with prefix-sharing paths, and a gitlink when asked. */
function realIndex(version: 2 | 3 | 4, gitlink: boolean): Buffer {
  git("init", "-q");
  for (const path of ["src/a/1.txt", "src/a/2.txt", "src/b/3.txt", "top.txt"]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), path);
  }
  git("add", ".");
  if (gitlink) git("update-index", "--add", "--cacheinfo", `160000,${SHA},zz-sub`);
  git("update-index", "--index-version", String(version));
  if (version === 3) git("update-index", "--skip-worktree", "top.txt");
  const bytes = readFileSync(join(dir, ".git", "index"));
  expect(bytes.readUInt32BE(4)).toBe(version);
  return bytes;
}

describe.each([2, 3, 4] as const)("a real index, version %i", (version) => {
  it("is clean without a gitlink", () => {
    expect(indexVerdict(realIndex(version, false))).toBe("clean");
  });
  it("finds a gitlink among prefix-sharing paths", () => {
    expect(indexVerdict(realIndex(version, true))).toBe("gitlink");
  });
  it("is unreadable when truncated", () => {
    const bytes = realIndex(version, true);
    expect(indexVerdict(bytes.subarray(0, bytes.length - 30))).toBe("unreadable");
    expect(indexVerdict(bytes.subarray(0, bytes.length - 1))).toBe("unreadable");
  });
  it("does not verify the checksum: a zero trailer and a changed trailer read the same", () => {
    const bytes = Buffer.from(realIndex(version, true));
    bytes.fill(0, bytes.length - 20);
    expect(indexVerdict(bytes)).toBe("gitlink");
    bytes[bytes.length - 1] = 7;
    expect(indexVerdict(bytes)).toBe("gitlink");
  });
});

describe("an index written with index.skipHash (feature.manyFiles)", () => {
  it("has an all-zero trailer and reads as before", () => {
    git("init", "-q");
    writeFileSync(join(dir, "a.txt"), "a");
    git("-c", "index.skipHash=true", "add", "a.txt");
    git("-c", "index.skipHash=true", "update-index", "--add", "--cacheinfo", `160000,${SHA},sub`);
    const bytes = readFileSync(join(dir, ".git", "index"));
    expect(bytes.subarray(bytes.length - 20)).toEqual(Buffer.alloc(20));
    expect(indexVerdict(bytes)).toBe("gitlink");
  });
});

describe("a doctored index", () => {
  it("asks for a split index (link extension), real git", () => {
    realIndex(2, false);
    git("update-index", "--split-index");
    expect(indexVerdict(readFileSync(join(dir, ".git", "index")))).toBe("unreadable");
  });
  it("asks for a sparse index (sdir extension)", () => {
    expect(indexVerdict(seal(Buffer.concat([header(2, 0), extension("sdir", 0)])))).toBe("unreadable");
  });
  it("asks for a bad signature", () => {
    expect(indexVerdict(seal(header(2, 0, "DIRX")))).toBe("unreadable");
  });
  it.each([0, 1, 5, 99])("asks for version %i", (version) => {
    expect(indexVerdict(seal(header(version, 0)))).toBe("unreadable");
  });
  it("asks for more entries than the cap, and reads an empty index", () => {
    expect(indexVerdict(seal(header(2, MAX_INDEX_ENTRIES + 1)))).toBe("unreadable");
    expect(indexVerdict(seal(header(2, 0)))).toBe("clean");
  });
  it("asks when the entry count promises more than the file holds", () => {
    expect(indexVerdict(seal(header(2, 1)))).toBe("unreadable");
  });
  it("asks for an unknown extension (git dies on a lowercase one; MC11) and for one that overruns", () => {
    expect(indexVerdict(seal(Buffer.concat([header(2, 0), extension("zzzz", 3)])))).toBe("unreadable");
    const overrun = extension("zzzz", 3);
    overrun.writeUInt32BE(900, 4);
    expect(indexVerdict(seal(Buffer.concat([header(2, 0), overrun])))).toBe("unreadable");
  });
  it("asks for an input shorter than a header and its checksum", () => {
    expect(indexVerdict(Buffer.alloc(0))).toBe("unreadable");
    expect(indexVerdict(Buffer.alloc(31))).toBe("unreadable");
  });
});

describe("entry boundaries are walked as git walks them (MC10, N1)", () => {
  const v2 = (...entries: Buffer[]): Buffer => seal(Buffer.concat([header(2, entries.length), ...entries]));
  const v3 = (...entries: Buffer[]): Buffer => seal(Buffer.concat([header(3, entries.length), ...entries]));
  const v4 = (...entries: Buffer[]): Buffer => seal(Buffer.concat([header(4, entries.length), ...entries]));

  it("reads well-formed hand-made entries, including a gitlink after a plain file", () => {
    expect(indexVerdict(v2(entryV2("a.txt"), entryV2("sub", GITLINK)))).toBe("gitlink");
    expect(indexVerdict(v2(entryV2("a.txt"), entryV2("b.txt")))).toBe("clean");
    expect(indexVerdict(v3(entryV2("a.txt", FILE, { extendedWord: 0 }), entryV2("sub", GITLINK)))).toBe(
      "gitlink",
    );
  });
  it("asks when the length field is shorter than the name", () => {
    expect(indexVerdict(v2(entryV2("abcdef", FILE, { lengthField: 3 }), entryV2("sub", GITLINK)))).toBe(
      "unreadable",
    );
  });
  it("asks when the length field is longer than the name", () => {
    expect(indexVerdict(v2(entryV2("abc", FILE, { lengthField: 9 }), entryV2("sub", GITLINK)))).toBe(
      "unreadable",
    );
  });
  it("asks when the name holds a NUL before the length says", () => {
    expect(indexVerdict(v2(entryV2("ab\0cd", FILE), entryV2("sub", GITLINK)))).toBe("unreadable");
  });
  it("scans to the NUL for a name of 0xFFF bytes or more, and asks for a short name marked 0xFFF", () => {
    expect(indexVerdict(v2(entryV2("a".repeat(5000), GITLINK, { lengthField: 0xfff })))).toBe("gitlink");
    expect(indexVerdict(v2(entryV2("a".repeat(4095), GITLINK)))).toBe("gitlink");
    expect(indexVerdict(v2(entryV2("short", FILE, { lengthField: 0xfff })))).toBe("unreadable");
  });
  it("asks for the extended-flags bit in a version 2 index", () => {
    expect(indexVerdict(v2(entryV2("a", FILE, { extendedWord: 0 })))).toBe("unreadable");
  });
  it("asks for padding that does not reach a multiple of 8 bytes", () => {
    expect(indexVerdict(v2(entryV2("abc", FILE, { padding: 1 }), entryV2("sub", GITLINK)))).toBe(
      "unreadable",
    );
  });

  it("reads version 4 prefix compression by hand", () => {
    const entries = [
      entryV4(varintBytes(0), "src/a/1", 7),
      entryV4(varintBytes(1), "b/2", 9),
      entryV4(varintBytes(3), "sub", 9, GITLINK),
    ];
    expect(indexVerdict(v4(...entries.slice(0, 2)))).toBe("clean");
    expect(indexVerdict(v4(...entries))).toBe("gitlink");
  });
  it("asks when the strip length is longer than the previous name (also for the first entry)", () => {
    expect(indexVerdict(v4(entryV4(varintBytes(1), "a", 1)))).toBe("unreadable");
    expect(indexVerdict(v4(entryV4(varintBytes(0), "ab", 2), entryV4(varintBytes(3), "x", 1, GITLINK)))).toBe(
      "unreadable",
    );
  });
  it("asks for an over-long or unterminated varint", () => {
    expect(indexVerdict(v4(entryV4(varintBytes(0x81, 0x81, 0x81, 0x81, 0x81, 0x00), "a", 1)))).toBe(
      "unreadable",
    );
    expect(indexVerdict(v4(entryV4(varintBytes(0x80), "", 0)))).toBe("unreadable");
  });
});

describe("version 4 entries are sized by the flags name length, as git sizes them (MC10 round 3)", () => {
  const v4 = (...entries: Buffer[]): Buffer => seal(Buffer.concat([header(4, entries.length), ...entries]));

  /** A gitlink only git sees: entry 0 states a 70-byte name but ends its suffix after 1 byte, so a NUL scan stops early. */
  function hidden(): Buffer {
    const bytes = Buffer.alloc(231);
    bytes.write("DIRC", 0, "latin1");
    bytes.writeUInt32BE(4, 4);
    bytes.writeUInt32BE(2, 8);
    // Entry 0 as git reads it: 12..146 (62 fixed + 1 varint + 70 name + 1 NUL), name length field 70.
    bytes.writeUInt32BE(FILE, 12 + 24);
    bytes.writeUInt16BE(70, 12 + 60);
    bytes[74] = 0; // strip varint
    bytes[75] = 0x61; // 'a', then the NUL at 76 that a scan stops at
    // Entry 1 as a NUL-scanning reader sees it: starts at 77, a plain file.
    bytes.writeUInt32BE(FILE, 77 + 24);
    bytes.writeUInt16BE(1, 77 + 60);
    bytes[139] = 0;
    bytes[140] = 0x62;
    bytes[141] = 0;
    // ... after which a TREE extension swallows git's real entry 1 up to the trailer.
    bytes.write("TREE", 142, "latin1");
    bytes.writeUInt32BE(61, 146);
    // Entry 1 as git reads it: starts at 146, a gitlink, strip 70 (a fresh name), suffix "c".
    bytes.writeUInt32BE(GITLINK, 146 + 24);
    bytes.writeUInt16BE(1, 146 + 60);
    bytes[208] = 70;
    bytes[209] = 0x63;
    bytes[210] = 0;
    return bytes;
  }

  it("the crafted index is a real gitlink for git", () => {
    git("init", "-q");
    writeFileSync(join(dir, ".git", "index"), hidden());
    const listed = execFileSync("git", ["ls-files", "-s"], {
      cwd: dir,
      encoding: "latin1",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    expect(listed).toContain("160000");
  });
  it("is not read as clean", () => {
    expect(indexVerdict(hidden())).not.toBe("clean");
    expect(indexVerdict(hidden())).toBe("unreadable");
  });

  it("reads field == copy length (an empty suffix) and finds the gitlink", () => {
    expect(indexVerdict(v4(entryV4(varintBytes(0), "abc", 3), entryV4(varintBytes(0), "", 3, GITLINK)))).toBe(
      "gitlink",
    );
  });
  it("asks when the field is shorter than the copied prefix", () => {
    expect(indexVerdict(v4(entryV4(varintBytes(0), "abc", 3), entryV4(varintBytes(0), "", 2, GITLINK)))).toBe(
      "unreadable",
    );
  });
  it("asks when the field is longer or shorter than the NUL-delimited suffix", () => {
    expect(indexVerdict(v4(entryV4(varintBytes(0), "a", 5, GITLINK)))).toBe("unreadable");
    expect(indexVerdict(v4(entryV4(varintBytes(0), "abc", 1, GITLINK)))).toBe("unreadable");
  });
  it("scans to the NUL for field 0xFFF, counting the copied prefix, and asks for a short total", () => {
    const long = entryV4(varintBytes(0), "a".repeat(5000), 0xfff);
    expect(indexVerdict(v4(long, entryV4(varintBytes(0), "x", 0xfff, GITLINK)))).toBe("gitlink");
    expect(indexVerdict(v4(entryV4(varintBytes(0), "short", 0xfff, GITLINK)))).toBe("unreadable");
  });
});
