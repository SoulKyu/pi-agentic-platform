import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fileMember,
  gnuTar,
  hiddenSymlink,
  paxMember,
  paxRecord,
  rawHeader,
  smuggleArchive,
  writeGzTar,
} from "../testing/tar-fixtures.ts";
import { listMembers, RESTORE_LIMITS } from "./tar-list.ts";

const LIMITS = { maxEntries: 1_000_000, maxBytes: 64 * 1024 ** 3 };

let scratch: string;
let tree: string;
let archive: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-tar-header-"));
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

describe("the reader and tar must agree on every header field (review fix round 1)", () => {
  /** Rewrites the header block of `agents/x` in the hidden-symlink archive; `edit` gets the block. */
  const tamper = (edit: (block: Buffer) => void): void => {
    smuggleArchive(scratch, archive, hiddenSymlink(join(scratch, "elsewhere")), []);
    const tar = gunzipSync(readFileSync(archive));
    for (let at = 0; at + 512 <= tar.length; at += 512) {
      if (tar.subarray(at, at + 9).toString("latin1") === "agents/x\0") {
        edit(tar.subarray(at, at + 512));
        writeFileSync(archive, gzipSync(tar));
        return;
      }
    }
    throw new Error("header not found");
  };
  const resum = (block: Buffer): void => {
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  };
  const assertTarStillCreatesTheLink = (): void => {
    const stage = join(scratch, "stage");
    extractWithTar(stage);
    expect(lstatSync(join(stage, "agents/evil")).isSymbolicLink()).toBe(true);
  };

  it.each([
    [
      "a no-break space before the digits",
      (digits: Buffer) => Buffer.concat([Buffer.from([0xc2, 0xa0]), digits]),
    ],
    [
      "a no-break space after the digits",
      (digits: Buffer) => Buffer.concat([digits, Buffer.from([0xc2, 0xa0])]),
    ],
    [
      "a byte order mark before the digits",
      (digits: Buffer) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), digits.subarray(1)]),
    ],
  ])(
    "a checksum field with %s hides the symlink from a UTF-8 reader but not from tar (I1)",
    async (_name, build) => {
      tamper((block) => {
        build(Buffer.from(block.subarray(148, 154))).copy(block, 148);
      });
      assertTarStillCreatesTheLink();
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
    },
  );

  it("a size field with a no-break space is skipped by tar and refused by the reader (M8)", async () => {
    tamper((block) => {
      const digits = Buffer.from(block.subarray(125, 135));
      Buffer.concat([Buffer.from([0xc2, 0xa0]), digits]).copy(block, 124);
      resum(block);
    });
    assertTarStillCreatesTheLink();
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
  });

  it("still accepts the checksum forms GNU tar writes: six digits, NUL, space", async () => {
    writeGzTar(archive, [fileMember("ok", "x")]);
    await expect(listMembers(archive, LIMITS)).resolves.toHaveLength(1);
  });

  it.each([0o000, 0o600, 0o200, 0o400, 0o100])(
    "refuses a folder with mode %o and content (I2)",
    async (mode) => {
      writeGzTar(archive, [
        rawHeader({ name: "agents/locked", type: "5", mode }),
        fileMember("agents/locked/f", "x"),
      ]);
      await expect(listMembers(archive, LIMITS)).rejects.toThrow(
        "the archive holds a folder the owner cannot read",
      );
    },
  );

  it("refuses a real GNU folder without owner read and execute, and accepts a 0555 one", async () => {
    mkdirSync(join(tree, "locked"));
    mkdirSync(join(tree, "readonly"));
    chmodSync(join(tree, "locked"), 0o600);
    chmodSync(join(tree, "readonly"), 0o555);
    gnuTar(tree, archive, ["readonly"]);
    await expect(listMembers(archive, LIMITS)).resolves.toEqual([{ path: "readonly", kind: "dir", size: 0 }]);
    gnuTar(tree, archive + "2", ["locked"]);
    await expect(listMembers(archive + "2", LIMITS)).rejects.toThrow(
      "the archive holds a folder the owner cannot read",
    );
    chmodSync(join(tree, "locked"), 0o700);
    chmodSync(join(tree, "readonly"), 0o700);
  });

  it("refuses a file at a folder that an earlier member implied (M1)", async () => {
    writeFileSync(join(tree, "a"), "1");
    writeFileSync(join(tree, "b"), "2");
    gnuTar(tree, archive, ["a", "b"], ["--transform=s,^a$,state.db/inner,;s,^b$,state.db,"]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive lists a name twice");
  });

  it("accepts a member before the folder it lives in, and a deep chain up to 128 parts", async () => {
    writeGzTar(archive, [fileMember("d/f", "x"), rawHeader({ name: "d", type: "5", mode: 0o755 })]);
    await expect(listMembers(archive, LIMITS)).resolves.toHaveLength(2);
    const deep = (parts: number): string => `${"d/".repeat(parts - 1)}f`;
    writeGzTar(archive, [paxMember(paxRecord("path", deep(128))), fileMember("x", "y")]);
    await expect(listMembers(archive, LIMITS)).resolves.toHaveLength(1);
    writeGzTar(archive, [paxMember(paxRecord("path", deep(129))), fileMember("x", "y")]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(
      "the archive nests folders deeper than a backup does",
    );
  });

  it("refuses a regular file below an implied chain whose top is a file", async () => {
    writeGzTar(archive, [fileMember("a", "1"), fileMember("a/b/c/d", "2")]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive puts a member below a file");
  });

  it("refuses the contiguous-file type 7, which tar extracts as a regular file", async () => {
    writeGzTar(archive, [rawHeader({ name: "f", type: "7" })]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(
      "the archive holds a link, a device or another special member",
    );
  });

  it("accepts a pax header of exactly 64 KiB and refuses one byte more", async () => {
    const header = (total: number): Buffer => {
      const body = Buffer.from(`${total} path=${"a".repeat(total - String(total).length - 7)}\n`);
      expect(body.length).toBe(total);
      const padded = Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
      return Buffer.concat([rawHeader({ name: "PaxHeaders/x", type: "x", size: total }), padded]);
    };
    // a 65 536-character path is refused by the path rules, after the header itself was read: the message tells which limit spoke
    writeGzTar(archive, [header(64 * 1024), fileMember("x", "y")]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive holds a path that is not safe");
    writeGzTar(archive, [header(64 * 1024 + 1), fileMember("x", "y")]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
  });

  it("pins the restore limits", () => {
    expect(RESTORE_LIMITS).toEqual({ maxEntries: 1_000_000, maxBytes: 68_719_476_736 });
  });

  it("releases the file descriptor when the gzip stream is bad (M7)", async () => {
    writeFileSync(archive, "not gzip, but long enough to start a stream ".repeat(100));
    const before = readdirSync("/proc/self/fd").length;
    for (let i = 0; i < 20; i++)
      await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive is not a readable gzip tar");
    expect(readdirSync("/proc/self/fd").length).toBe(before);
  });

  it("counts the folders a deep member implies against maxEntries, before they are stored (I4)", async () => {
    const chain = (n: number): string => `u${n}/${"d/".repeat(126)}f`; // 128 parts, 127 implied folders each
    writeGzTar(archive, [
      ...[0, 1, 2].flatMap((n) => [paxMember(paxRecord("path", chain(n))), fileMember("x", "y")]),
    ]);
    // 3 members + 3 x 127 implied folders = 384 entries
    await expect(listMembers(archive, { maxEntries: 384, maxBytes: 1e9 })).resolves.toHaveLength(3);
    await expect(listMembers(archive, { maxEntries: 383, maxBytes: 1e9 })).rejects.toThrow(
      "the archive is larger than a backup can be",
    );
    await expect(listMembers(archive, { maxEntries: 100, maxBytes: 1e9 })).rejects.toThrow(
      "the archive is larger than a backup can be",
    );
  });

  it("stops at the first deep member that crosses the cap: one member alone is refused", async () => {
    writeGzTar(archive, [paxMember(paxRecord("path", `${"d/".repeat(126)}f`)), fileMember("x", "y")]);
    await expect(listMembers(archive, { maxEntries: 50, maxBytes: 1e9 })).rejects.toThrow(
      "the archive is larger than a backup can be",
    );
  });
});
