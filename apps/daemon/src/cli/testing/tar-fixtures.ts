import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

/** The flags `pap backup` gives GNU tar (see `tarCreateArgs`), without the file list. */
export const PAX_FLAGS = ["--format=pax", "--owner=0", "--group=0", "--numeric-owner"] as const;

export const BLOCK = 512;

export interface RawHeader {
  readonly name: string;
  readonly size?: number;
  /** One character: "0" file, "5" folder, "1" hard link, "2" symbolic link, "3" device, "6" FIFO, "x" pax. */
  readonly type?: string;
  readonly linkname?: string;
  readonly prefix?: string;
  /** Six bytes at offset 257: "ustar\0" by default, "ustar " is the old GNU form (then `version` is " \0"). */
  readonly magic?: string;
  readonly version?: string;
  /** The twelve raw bytes of the size field, replacing the octal digits. */
  readonly sizeRaw?: Buffer;
  /** A base-256 size field (high bit set) instead of octal digits. */
  readonly base256?: boolean;
  readonly mode?: number;
}

const put = (block: Buffer, text: string, at: number, length: number): void => {
  block.write(text.slice(0, length), at, "utf8");
};

/** A ustar header block with a correct checksum, written by hand so a test can build what GNU tar would never write. */
export function rawHeader(spec: RawHeader): Buffer {
  const block = Buffer.alloc(BLOCK);
  put(block, spec.name, 0, 100);
  put(block, (spec.mode ?? 0o644).toString(8).padStart(7, "0"), 100, 7);
  put(block, "0000000", 108, 7);
  put(block, "0000000", 116, 7);
  if (spec.sizeRaw !== undefined) {
    spec.sizeRaw.copy(block, 124, 0, 12);
  } else if (spec.base256 === true) {
    block[124] = 0x80;
    block[135] = spec.size ?? 1;
  } else {
    put(block, (spec.size ?? 0).toString(8).padStart(11, "0"), 124, 11);
  }
  put(block, "00000000000", 136, 11);
  block.fill(0x20, 148, 156);
  block.write(spec.type ?? "0", 156, "latin1");
  put(block, spec.linkname ?? "", 157, 100);
  block.write(spec.magic ?? "ustar\0", 257, "latin1");
  block.write(spec.version ?? "00", 263, "latin1");
  put(block, spec.prefix ?? "", 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(block, sum.toString(8).padStart(6, "0"), 148, 6);
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

export const padTo = (data: Buffer): Buffer => {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
};

/** A file member: header then padded content. */
export const fileMember = (name: string, content: string | Buffer): Buffer => {
  const data = Buffer.from(content);
  return Buffer.concat([rawHeader({ name, size: data.length }), padTo(data)]);
};

/** `<len> <key>=<value>\n`, the length counting itself. */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length++;
  return Buffer.from(`${length}${body}`);
}

/** An extended header (type x) holding the given raw record bytes. */
export const paxMember = (...records: Buffer[]): Buffer => {
  const data = Buffer.concat(records);
  return Buffer.concat([rawHeader({ name: "PaxHeaders/x", type: "x", size: data.length }), padTo(data)]);
};

export const END = Buffer.alloc(2 * BLOCK);

/** Writes a gzip tar made of the given blocks; the two zero end blocks are added unless `end` is false. */
export function writeGzTar(file: string, parts: readonly Buffer[], end = true): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, gzipSync(Buffer.concat(end ? [...parts, END] : [...parts])));
}

/** Runs the same GNU tar command line a backup uses over `names` taken from `cwd`. */
export function gnuTar(
  cwd: string,
  archive: string,
  names: readonly string[],
  extra: readonly string[] = [],
): void {
  mkdirSync(dirname(archive), { recursive: true });
  execFileSync(
    "tar",
    [...PAX_FLAGS, ...extra, "--no-recursion", "--create", "--gzip", "--file", archive, "-C", cwd, ...names],
    { stdio: "pipe" },
  );
}

/**
 * The member names of a gzip tar as GNU tar lists them (a folder keeps its trailing slash; trimmed here so the result
 * compares with `listMembers`).
 */
export const tarNames = (archive: string): string[] =>
  execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((name) => name.replace(/\/$/, ""));

/**
 * M6b-RT-01: the content of `agents/x` is itself tar blocks: a symbolic link `agents/evil -> target` and a file below it.
 * Archived with `--pax-option=size:=0`, GNU tar reads the pax size (0) and parses that content as headers, while the
 * ustar size field of the outer member says it is plain content.
 */
export function smuggleArchive(
  root: string,
  archive: string,
  hidden: Buffer,
  paxOptions: readonly string[] = ["--pax-option=size:=0"],
): void {
  const work = join(root, "smuggle-work");
  mkdirSync(join(work, "agents"), { recursive: true });
  writeFileSync(join(work, "agents", "x"), hidden);
  writeFileSync(join(work, "agents", "a"), "");
  gnuTar(work, archive, ["agents/a", "agents/x"], paxOptions);
}

export const hiddenSymlink = (target: string): Buffer =>
  Buffer.concat([
    rawHeader({ name: "agents/evil", type: "2", linkname: target }),
    fileMember("agents/evil/pwn", "pwn"),
  ]);

export const hiddenHardLink = (target: string): Buffer =>
  rawHeader({ name: "agents/b", type: "1", linkname: target });
