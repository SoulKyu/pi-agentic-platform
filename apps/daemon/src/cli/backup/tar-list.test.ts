import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileMember, gnuTar, rawHeader, tarNames, writeGzTar } from "../testing/tar-fixtures.ts";
import { listMembers } from "./tar-list.ts";

const LIMITS = { maxEntries: 1_000_000, maxBytes: 64 * 1024 ** 3 };
const SPECIAL = "the archive holds a link, a device or another special member";
const UNSAFE = "the archive holds a path that is not safe";

let scratch: string;
let tree: string;
let archive: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-tar-list-"));
  tree = join(scratch, "tree");
  mkdirSync(tree);
  archive = join(scratch, "a.tar.gz");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const write = (relative: string, text = "x"): void => {
  mkdirSync(join(tree, relative, ".."), { recursive: true });
  writeFileSync(join(tree, relative), text);
};

describe("listMembers on archives GNU tar writes", () => {
  it("lists what tar -t lists, with a 180-character name, an executable script and empty folders", async () => {
    const long = "n".repeat(180);
    write("agents/one/run.sh", "#!/bin/sh\n");
    chmodSync(join(tree, "agents/one/run.sh"), 0o755);
    write(`agents/one/${long}`, "long");
    write("attachments/a.bin", "12345");
    mkdirSync(join(tree, "exports/empty"), { recursive: true });
    const names = [
      "agents",
      "agents/one",
      "agents/one/run.sh",
      `agents/one/${long}`,
      "attachments",
      "attachments/a.bin",
      "exports",
      "exports/empty",
    ];
    gnuTar(tree, archive, names);
    const members = await listMembers(archive, LIMITS);
    expect(members.map((member) => member.path)).toEqual(tarNames(archive));
    expect(members.map((member) => member.path)).toEqual(names);
    const byPath = new Map(members.map((member) => [member.path, member]));
    expect(byPath.get("agents/one/run.sh")).toEqual({ path: "agents/one/run.sh", kind: "file", size: 10 });
    expect(byPath.get(`agents/one/${long}`)?.size).toBe(4);
    expect(byPath.get("exports/empty")).toEqual({ path: "exports/empty", kind: "dir", size: 0 });
  });

  it("accepts an archive of one file larger than a block and pads of the 10240-byte record", async () => {
    write("attachments/big.bin", "z".repeat(70_000));
    gnuTar(tree, archive, ["attachments", "attachments/big.bin"]);
    const members = await listMembers(archive, LIMITS);
    expect(members.at(-1)).toEqual({ path: "attachments/big.bin", kind: "file", size: 70_000 });
  });

  it("refuses a symbolic link member", async () => {
    write("agents/real");
    symlinkSync("real", join(tree, "agents/link"));
    gnuTar(tree, archive, ["agents", "agents/real", "agents/link"]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(SPECIAL);
  });

  it("refuses a hard link member", async () => {
    write("agents/one");
    linkSync(join(tree, "agents/one"), join(tree, "agents/two"));
    gnuTar(tree, archive, ["agents/one", "agents/two"]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(SPECIAL);
  });

  it("refuses a FIFO member", async () => {
    mkdirSync(join(tree, "agents"));
    execFileSync("mkfifo", [join(tree, "agents/pipe")]);
    gnuTar(tree, archive, ["agents/pipe"]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(SPECIAL);
  });

  it("refuses a name with .. , an absolute name and a name with a newline", async () => {
    write("plain");
    gnuTar(tree, archive, ["plain"], ["--transform=s,^plain$,../x,"]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow(UNSAFE);
    gnuTar(tree, archive + "2", ["plain"], ["--transform=s,^plain$,/etc/x,"]);
    await expect(listMembers(archive + "2", LIMITS)).rejects.toThrow(UNSAFE);
    write("two\nlines");
    gnuTar(tree, archive + "3", ["two\nlines"]);
    await expect(listMembers(archive + "3", LIMITS)).rejects.toThrow(UNSAFE);
  });

  it("says 'not a readable gzip tar' for a gzip stream cut in half and for junk", async () => {
    write("attachments/a.bin", "x".repeat(200_000));
    gnuTar(tree, archive, ["attachments", "attachments/a.bin"]);
    const bytes = readFileSync(archive);
    writeFileSync(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive is not a readable gzip tar");
    writeFileSync(archive, "this is not a gzip file at all");
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive is not a readable gzip tar");
    writeFileSync(archive, "");
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("the archive is not a readable gzip tar");
  });

  it("refuses data after the two zero blocks", async () => {
    writeGzTar(archive, [fileMember("a", "x"), Buffer.alloc(1024), fileMember("b", "y")], false);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("data after the end of the archive");
  });

  it("refuses a pax header above 64 KiB", async () => {
    writeGzTar(archive, [rawHeader({ name: "PaxHeaders/x", type: "x", size: 64 * 1024 + 1 })]);
    await expect(listMembers(archive, LIMITS)).rejects.toThrow("unreadable tar header");
  });

  it("refuses more members than maxEntries and more declared bytes than maxBytes", async () => {
    write("a", "12345");
    write("b", "12345");
    write("c", "12345");
    gnuTar(tree, archive, ["a", "b", "c"]);
    await expect(listMembers(archive, { maxEntries: 3, maxBytes: 100 })).resolves.toHaveLength(3);
    await expect(listMembers(archive, { maxEntries: 2, maxBytes: 100 })).rejects.toThrow(
      "the archive is larger than a backup can be",
    );
    await expect(listMembers(archive, { maxEntries: 3, maxBytes: 15 })).resolves.toHaveLength(3);
    await expect(listMembers(archive, { maxEntries: 3, maxBytes: 14 })).rejects.toThrow(
      "the archive is larger than a backup can be",
    );
  });

  it("reads the signed checksum some tar writers produce for a name with high bytes", async () => {
    const header = rawHeader({ name: "caf\u00e9" });
    let signed = 0;
    for (let i = 0; i < 512; i++) {
      const byte = i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
      signed += byte > 127 ? byte - 256 : byte;
    }
    header.write(signed.toString(8).padStart(6, "0"), 148, "latin1");
    writeGzTar(archive, [header]);
    await expect(listMembers(archive, LIMITS)).resolves.toEqual([
      { path: "caf\u00e9", kind: "file", size: 0 },
    ]);
  });
});
