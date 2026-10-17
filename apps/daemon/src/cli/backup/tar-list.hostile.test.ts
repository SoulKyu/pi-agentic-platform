import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fileMember,
  gnuTar,
  hiddenHardLink,
  hiddenSymlink,
  paxMember,
  paxRecord,
  rawHeader,
  smuggleArchive,
  writeGzTar,
} from "../testing/tar-fixtures.ts";
import { listMembers } from "./tar-list.ts";

const LIMITS = { maxEntries: 1_000_000, maxBytes: 64 * 1024 ** 3 };
const UNKNOWN_RECORD = "the archive uses an extended header record this reader does not accept";

let scratch: string;
let tree: string;
let archive: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-tar-hostile-"));
  tree = join(scratch, "tree");
  mkdirSync(tree);
  archive = join(scratch, "a.tar.gz");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const extractWithTar = (target: string): void => {
  mkdirSync(target);
  try {
    execFileSync(
      "tar",
      ["-xzf", archive, "-C", target, "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir"],
      { stdio: "pipe" },
    );
  } catch {
    // tar exits 2 when the member below the symbolic link cannot be written; the link has landed by then
  }
};

const reGzip = (edit: (tar: Buffer) => Buffer): void => {
  writeFileSync(archive, gzipSync(edit(gunzipSync(readFileSync(archive)))));
};

describe("M6b-RT-01 hostile archives, layer 1 (the reader), each built for real", () => {
  it("(1) the hidden symlink: refused by the reader, while real tar -x does create the link", async () => {
    smuggleArchive(scratch, archive, hiddenSymlink(join(scratch, "elsewhere")));
    // control: this archive is only a differential while GNU tar honours the pax size
    const stage = join(scratch, "stage");
    extractWithTar(stage);
    expect(lstatSync(join(stage, "agents/evil")).isSymbolicLink()).toBe(true);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(UNKNOWN_RECORD);
  });

  it("(2) the hidden hard link: refused by the reader, and tar -x does create a second name for the file", async () => {
    smuggleArchive(scratch, archive, hiddenHardLink("/etc/hostname"));
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(UNKNOWN_RECORD);
    smuggleArchive(scratch, archive, hiddenHardLink("agents/a"));
    const stage = join(scratch, "stage");
    extractWithTar(stage);
    expect(lstatSync(join(stage, "agents/b")).nlink).toBe(2);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(UNKNOWN_RECORD);
  });

  describe("(3) one test per refused record", () => {
    const single = (option: string, extra: string[] = []): void => {
      writeFileSync(join(tree, "f"), "hi");
      gnuTar(tree, archive, ["f"], [option, ...extra]);
    };

    it.each([
      ["size", "size:=0"],
      ["linkpath", "linkpath:=target"],
      ["uid", "uid:=1000"],
    ])("a %s record written by GNU tar", async (_name, option) => {
      single(`--pax-option=${option}`);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow(UNKNOWN_RECORD);
    });

    it("a global extended header (hdrcharset=BINARY makes GNU tar write one)", async () => {
      single("--pax-option=hdrcharset=BINARY");
      await expect(listMembers(archive, LIMITS)).rejects.toThrow(
        "the archive holds a link, a device or another special member",
      );
    });

    it("an hdrcharset record in a member's extended header", async () => {
      writeGzTar(archive, [paxMember(paxRecord("hdrcharset", "BINARY")), fileMember("f", "hi")]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow(UNKNOWN_RECORD);
    });

    it("a GNU.sparse record from a sparse file archived with -S", async () => {
      const sparse = join(tree, "sp");
      writeFileSync(sparse, "");
      truncateSync(sparse, 5 * 1024 * 1024);
      const fd = openSync(sparse, "r+");
      writeSync(fd, "z", 3_000_000);
      closeSync(fd);
      gnuTar(tree, archive, ["sp"], ["-S"]);
      const text = gunzipSync(readFileSync(archive)).toString("latin1");
      expect(text).toContain("GNU.sparse.major=1");
      await expect(listMembers(archive, LIMITS)).rejects.toThrow(UNKNOWN_RECORD);
    });

    it.each(["comment", "GNU.foo", "SCHILY.xattr.user.a", "charset", "gid", "gname"])(
      "a %s record",
      async (key) => {
        writeGzTar(archive, [paxMember(paxRecord(key, "1")), fileMember("f", "hi")]);
        await expect(listMembers(archive, LIMITS)).rejects.toThrow(UNKNOWN_RECORD);
      },
    );

    it("a record that is not key=value, and one whose length lies", async () => {
      writeGzTar(archive, [paxMember(Buffer.from("8 novalu\n")), fileMember("f", "hi")]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
      writeGzTar(archive, [paxMember(Buffer.from("99 path=f\n")), fileMember("f", "hi")]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
    });

    it.each(["path", "mtime", "atime", "ctime"])("accepts a lone %s record", async (key) => {
      const value = key === "path" ? "renamed" : "1792241185.402633561";
      writeGzTar(archive, [paxMember(paxRecord(key, value)), fileMember("f", "hi")]);
      const expected = key === "path" ? "renamed" : "f";
      await expect(listMembers(archive, LIMITS)).resolves.toEqual([
        { path: expected, kind: "file", size: 2 },
      ]);
    });
  });

  it("(4) a flipped byte in a header is a checksum mismatch, and so is a header without the ustar magic", async () => {
    writeFileSync(join(tree, "name-of-file"), "hi");
    gnuTar(tree, archive, ["name-of-file"]);
    await expect(listMembers(archive, LIMITS)).resolves.toHaveLength(1);
    const flip = (offset: number): void => {
      reGzip((tar) => {
        const copy = Buffer.from(tar);
        copy[offset] = (copy[offset] ?? 0) ^ 0x01;
        return copy;
      });
    };
    const real = (): number => {
      const tar = gunzipSync(readFileSync(archive));
      const at = tar.lastIndexOf("name-of-file");
      expect(at % 512).toBe(0);
      return at;
    };
    flip(real() + 3);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");

    writeFileSync(join(tree, "name-of-file"), "hi");
    gnuTar(tree, archive, ["name-of-file"]);
    flip(real() + 257);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");

    writeGzTar(archive, [rawHeader({ name: "f", magic: "xxxxx\0" })]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
  });

  it("(5) a pax header repeating path, a repeated time, and two extended headers in a row", async () => {
    writeGzTar(archive, [paxMember(paxRecord("path", "a"), paxRecord("path", "b")), fileMember("f", "hi")]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(
      "the archive repeats an extended header record",
    );
    writeGzTar(archive, [paxMember(paxRecord("mtime", "1"), paxRecord("mtime", "2")), fileMember("f", "hi")]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(
      "the archive repeats an extended header record",
    );
    writeGzTar(archive, [
      paxMember(paxRecord("path", "a")),
      paxMember(paxRecord("path", "b")),
      fileMember("f", "hi"),
    ]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
  });

  it("(5b) an extended header with no member after it is cut short", async () => {
    writeGzTar(archive, [paxMember(paxRecord("path", "a"))]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive is cut short");
  });

  it("(6) a member below a file, and a name listed twice", async () => {
    writeFileSync(join(tree, "a"), "1");
    writeFileSync(join(tree, "b"), "2");
    gnuTar(tree, archive, ["a", "b"], ["--transform=s,^b$,a/b,"]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive puts a member below a file");
    gnuTar(tree, archive + "2", ["a", "b"], ["--transform=s,^[ab]$,x,"]);
    await expect(listMembers(archive + "2", LIMITS)).rejects.toThrow("the archive lists a name twice");
    mkdirSync(join(tree, "d"));
    mkdirSync(join(tree, "e"));
    gnuTar(tree, archive + "3", ["d", "e/"], ["--transform=s,^[de]/*$,x/,"]);
    await expect(listMembers(archive + "3", LIMITS)).rejects.toThrow("the archive lists a name twice");
  });

  it("(7) an archive cut at a block boundary with no zero blocks, and one with a single zero block", async () => {
    writeGzTar(archive, [fileMember("a", "x")], false);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive is cut short");
    writeGzTar(archive, [fileMember("a", "x"), Buffer.alloc(512)], false);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive is cut short");
  });

  it("(7b) a file cut inside its content is cut short", async () => {
    writeGzTar(archive, [rawHeader({ name: "a", size: 5000 }), Buffer.alloc(1024)], false);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive is cut short");
  });

  it("(8) a size field in base-256 is unreadable", async () => {
    writeGzTar(archive, [rawHeader({ name: "a", base256: true, size: 1 }), Buffer.alloc(512)]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
  });

  it("a folder member that declares content is unreadable", async () => {
    writeGzTar(archive, [rawHeader({ name: "d", type: "5", size: 512 }), Buffer.alloc(512)]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
  });

  it("device members and a global extended header (type g) are refused", async () => {
    for (const type of ["3", "4", "g", "L", "K", "S", "D"]) {
      writeGzTar(archive, [rawHeader({ name: "d", type })]);
      await expect(listMembers(archive, LIMITS), `type ${type}`).rejects.toThrow(
        "the archive holds a link, a device or another special member",
      );
    }
  });

  describe("defects found in the prescribed reader (see the report)", () => {
    it("an extended header of size 0 is unreadable (it left a collector that swallowed the next member in memory)", async () => {
      writeGzTar(archive, [rawHeader({ name: "PaxHeaders/x", type: "x", size: 0 }), fileMember("f", "hi")]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
    });

    it("the old GNU magic is refused: its bytes at offset 345 are not a name prefix, tar and the reader would disagree", async () => {
      writeGzTar(archive, [rawHeader({ name: "evil", prefix: "agents", magic: "ustar ", version: " \0" })]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
    });

    it("a regular-file header whose name ends in a slash is refused: tar extracts it as a folder", async () => {
      writeGzTar(archive, [rawHeader({ name: "agents/d/", size: 0 })]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive holds a path that is not safe");
    });

    it("a size field that is not the eleven digits and a terminator tar writes is unreadable", async () => {
      const sizeRaw = Buffer.concat([Buffer.from("1"), Buffer.alloc(11)]);
      writeGzTar(archive, [rawHeader({ name: "a", sizeRaw }), Buffer.alloc(512)]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
    });

    it("an extended header record whose length has trailing characters is unreadable", async () => {
      writeGzTar(archive, [paxMember(Buffer.from("12x path=ab\n")), fileMember("f", "hi")]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
    });
  });
});
