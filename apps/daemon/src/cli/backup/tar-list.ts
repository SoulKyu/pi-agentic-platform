import { createReadStream } from "node:fs";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { safeMemberPath, UnsafeArchiveError } from "./member-path.ts";

export { safeMemberPath, UnsafeArchiveError };

export interface Member {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
}

export interface ListLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

/** M6bR6: at most 1 000 000 members and 64 GiB declared. `pap backup` checks its own file with the same numbers. */
export const RESTORE_LIMITS: ListLimits = { maxEntries: 1_000_000, maxBytes: 64 * 1024 ** 3 };

const BLOCK = 512;
const MAX_PAX = 64 * 1024;
/** A backup path is at most 1024 characters (`safeMemberPath`); real trees nest far less. Also bounds the work per member. */
const MAX_DEPTH = 128;
const tooLarge = (): UnsafeArchiveError =>
  new UnsafeArchiveError("the archive is larger than a backup can be");
const bad = (): UnsafeArchiveError => new UnsafeArchiveError("unreadable tar header");

const field = (block: Buffer, from: number, length: number): string => {
  const raw = block.subarray(from, from + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
};

/** The mode field as GNU tar writes it: seven octal digits and a terminator. */
function tarMode(block: Buffer): number {
  const raw = block.subarray(100, 108).toString("latin1");
  if (!/^[0-7]{7}[\0 ]$/.test(raw)) throw bad();
  return Number.parseInt(raw.slice(0, 7), 8);
}

/** The size field as GNU tar writes it: eleven octal digits and a terminator. Anything else (base-256, spaces, bytes after a NUL) is not read. */
function tarSize(block: Buffer): number {
  const raw = block.subarray(124, 136).toString("latin1");
  if (!/^[0-7]{11}[\0 ]$/.test(raw)) throw bad();
  return Number.parseInt(raw.slice(0, 11), 8);
}

/** The header checksum (offset 148, eight bytes) is the sum of the block with that field read as spaces; tar accepts the signed sum too. */
function checksumOk(block: Buffer): boolean {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  // ASCII only: tar skips a header whose field holds an NBSP or a BOM, and then reads the member's content as headers
  const match = /^ *([0-7]{1,7})[\0 ]*$/.exec(block.subarray(148, 156).toString("latin1"));
  if (match === null) throw bad();
  const stored = Number.parseInt(match[1] ?? "", 8);
  return stored === unsigned || stored === signed;
}

/** What GNU tar writes with `--format=pax` for the files a backup holds: the name and the three times. Nothing else is accepted. */
const PAX_TIME = new Set(["mtime", "atime", "ctime"]);

/**
 * The records of a pax extended header (`<len> <key>=<value>\n`). Returns the `path`, if any. Every key other than `path`,
 * `mtime`, `atime` and `ctime` refuses the archive: `size` would make GNU tar read a different length than the ustar header
 * says (a member's content would be parsed as headers), and `linkpath`, `GNU.*`, `hdrcharset`, `uid`... change what tar
 * extracts. A repeated key refuses too.
 */
function paxPath(body: Buffer): string | null {
  let at = 0;
  let found: string | null = null;
  const seen = new Set<string>();
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) throw bad();
    const digits = body.subarray(at, space).toString("latin1");
    const length = /^[1-9][0-9]{0,5}$/.test(digits) ? Number.parseInt(digits, 10) : 0;
    if (length < 4 || at + length > body.length || body[at + length - 1] !== 0x0a) throw bad();
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq < 1) throw bad();
    const key = record.slice(0, eq);
    if (seen.has(key)) throw new UnsafeArchiveError("the archive repeats an extended header record");
    seen.add(key);
    if (key === "path") found = record.slice(eq + 1);
    else if (!PAX_TIME.has(key))
      throw new UnsafeArchiveError("the archive uses an extended header record this reader does not accept");
    at += length;
  }
  return found;
}

/**
 * Reads the member headers of a gzip tar written with `--format=pax` WITHOUT extracting anything. Layer 1 of three (the
 * others: the `tar` flags and the post-extract walk): only regular files and folders are accepted, every header checksum
 * must match, only `path` and the times are accepted in an extended header, a name is listed once and never below a file,
 * and the archive must end with its two zero blocks. Bounded in entries and in declared bytes.
 */
export async function listMembers(file: string, limits: ListLimits): Promise<Member[]> {
  const members: Member[] = [];
  const kinds = new Set<string>();
  const folders = new Set<string>(); // listed folders and the folders implied by a member below them
  let implied = 0; // folders added to the set only because a member lives below them
  let bytes = 0;
  let pending: Buffer = Buffer.alloc(0);
  let skip = 0;
  let collect: { size: number; chunks: Buffer[] } | null = null;
  let nextPath: string | null = null;
  let havePax = false;
  let zeroBlocks = 0;

  const header = (block: Buffer): void => {
    if (block.every((byte) => byte === 0)) {
      zeroBlocks++;
      return;
    }
    if (zeroBlocks > 0) throw new UnsafeArchiveError("data after the end of the archive");
    // "ustar\0" and version "00" only: the old GNU magic ("ustar  ") puts other fields where the name prefix is
    if (block.subarray(257, 265).toString("latin1") !== "ustar\u000000" || !checksumOk(block)) throw bad();
    const type = String.fromCharCode(block[156] ?? 0);
    const size = tarSize(block);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      // size 0 would leave a collector open that gathers the next member's content in memory
      if (size === 0 || size > MAX_PAX || havePax) throw bad();
      havePax = true;
      collect = { size, chunks: [] };
      skip = padded;
      return;
    }
    const prefix = field(block, 345, 155);
    const name = nextPath ?? (prefix === "" ? field(block, 0, 100) : `${prefix}/${field(block, 0, 100)}`);
    nextPath = null;
    havePax = false;
    if (type !== "0" && type !== "\0" && type !== "5")
      throw new UnsafeArchiveError("the archive holds a link, a device or another special member");
    const kind = type === "5" ? "dir" : "file";
    // tar extracts a regular-file header whose name ends in a slash as a folder
    if (kind === "file" && name.endsWith("/"))
      throw new UnsafeArchiveError("the archive holds a path that is not safe");
    if (kind === "dir" && size !== 0) throw bad();
    // a folder without owner read and execute cannot be walked or removed by the restore
    if (kind === "dir" && (tarMode(block) & 0o500) !== 0o500)
      throw new UnsafeArchiveError("the archive holds a folder the owner cannot read");
    const path = safeMemberPath(name);
    if (kinds.has(path) || (kind === "file" && folders.has(path)))
      throw new UnsafeArchiveError("the archive lists a name twice");
    const parts = path.split("/");
    if (parts.length > MAX_DEPTH)
      throw new UnsafeArchiveError("the archive nests folders deeper than a backup does");
    // Every folder in the set has its ancestors in it, so the walk up stops at the first known one.
    for (let end = parts.length - 1; end > 0; end--) {
      const ancestor = parts.slice(0, end).join("/");
      if (kinds.has(ancestor) && !folders.has(ancestor))
        throw new UnsafeArchiveError("the archive puts a member below a file");
      if (folders.has(ancestor)) break;
      folders.add(ancestor);
      // tar creates every implied folder: they count like members, and the check runs before the set grows further
      implied++;
      if (members.length + 1 + implied > limits.maxEntries) throw tooLarge();
    }
    kinds.add(path);
    if (kind === "dir") folders.add(path);
    members.push({ path, kind, size });
    bytes += size;
    if (members.length + implied > limits.maxEntries || bytes > limits.maxBytes) throw tooLarge();
    skip = padded;
  };

  const feed = (chunk: Buffer): void => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (skip > 0) {
        const take = Math.min(skip, pending.length);
        if (collect !== null) collect.chunks.push(pending.subarray(0, take));
        pending = pending.subarray(take);
        skip -= take;
        if (skip > 0) return;
        if (collect !== null) {
          nextPath = paxPath(Buffer.concat(collect.chunks).subarray(0, collect.size));
          collect = null;
        }
        continue;
      }
      if (pending.length < BLOCK) return;
      header(Buffer.from(pending.subarray(0, BLOCK)));
      pending = pending.subarray(BLOCK);
    }
  };

  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      try {
        feed(chunk);
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
  try {
    await pipeline(createReadStream(file), createGunzip(), sink); // pipeline destroys every stream, so no descriptor leaks
  } catch (error) {
    if (error instanceof UnsafeArchiveError) throw error;
    if (
      typeof (error as { code?: unknown }).code === "string" &&
      (error as { code: string }).code.startsWith("Z_")
    )
      throw new UnsafeArchiveError("the archive is not a readable gzip tar");
    throw error;
  }
  if (skip > 0 || havePax || zeroBlocks < 2 || (pending.length > 0 && !pending.every((byte) => byte === 0)))
    throw new UnsafeArchiveError("the archive is cut short");
  return members;
}
