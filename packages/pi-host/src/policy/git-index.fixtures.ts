import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Index files built by hand for the index reader tests (`read-cache.c` layouts), and real git to read them back. */

export const FILE = 0o100644;
export const GITLINK = 0o160000;
export const HEADER_BYTES = 12;

export const header = (version: number, count: number, magic = "DIRC"): Buffer => {
  const out = Buffer.alloc(HEADER_BYTES);
  out.write(magic, 0, "latin1");
  out.writeUInt32BE(version, 4);
  out.writeUInt32BE(count, 8);
  return out;
};

/**
 * An all-zero trailer, as `index.skipHash` writes it: git does not verify the checksum for status, diff or log, so
 * neither does the reader, and these buffers need no hash.
 */
export const seal = (body: Buffer): Buffer => Buffer.concat([body, Buffer.alloc(20)]);

export interface EntryOptions {
  /** The flags name length; defaults to the name length (0xFFF past it). */
  readonly lengthField?: number;
  /** The extended flags word (git knows only 0x4000 skip-worktree and 0x2000 intent-to-add); sets bit 0x4000 of the flags. */
  readonly extendedWord?: number;
  readonly padding?: number;
  readonly stage?: number;
}

function fixedPart(mode: number, length: number, options: EntryOptions): Buffer {
  const extended = options.extendedWord !== undefined;
  const fixed = Buffer.alloc(extended ? 64 : 62);
  fixed.writeUInt32BE(mode >>> 0, 24);
  fixed.writeUInt16BE((length & 0x0fff) | ((options.stage ?? 0) << 12) | (extended ? 0x4000 : 0), 60);
  if (extended) fixed.writeUInt16BE(options.extendedWord ?? 0, 62);
  return fixed;
}

/** A version 2 or 3 entry written by hand: `lengthField` and `padding` can lie. */
export function entryV2(name: Buffer | string, mode = FILE, options: EntryOptions = {}): Buffer {
  const bytes = typeof name === "string" ? Buffer.from(name, "latin1") : name;
  const fixed = fixedPart(mode, options.lengthField ?? Math.min(bytes.length, 0xfff), options);
  const unpadded = fixed.length + bytes.length;
  const padding = options.padding ?? (((unpadded + 8) >> 3) << 3) - unpadded;
  return Buffer.concat([fixed, bytes, Buffer.alloc(padding)]);
}

export const varintBytes = (...bytes: number[]): Buffer => Buffer.from(bytes);

/** git's `encode_varint`: each continuation byte stands for one more than it says. */
export function encodeVarint(value: number): Buffer {
  const bytes = [value % 128];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    rest -= 1;
    bytes.unshift(0x80 | (rest % 128));
    rest = Math.floor(rest / 128);
  }
  return Buffer.from(bytes);
}

/** A version 4 entry: strip varint, then the NUL-terminated suffix. `field` is the flags name length git sizes it by. */
export function entryV4(
  strip: Buffer,
  suffix: string,
  field: number,
  mode = FILE,
  options: EntryOptions = {},
): Buffer {
  return Buffer.concat([
    fixedPart(mode, field, options),
    strip,
    Buffer.from(suffix, "latin1"),
    Buffer.alloc(1),
  ]);
}

/** An extension: a payload, or a size with a zero payload. */
export function extension(name: string, body: Buffer | number): Buffer {
  const payload = typeof body === "number" ? Buffer.alloc(body) : body;
  const out = Buffer.alloc(8);
  out.write(name, 0, "latin1");
  out.writeUInt32BE(payload.length, 4);
  return Buffer.concat([out, payload]);
}

const be32 = (...values: number[]): Buffer => {
  const out = Buffer.alloc(4 * values.length);
  values.forEach((value, index) => out.writeUInt32BE(value >>> 0, 4 * index));
  return out;
};

/** `IEOT` as git writes it: version 1, then an offset and an entry count per block. */
export const offsetTable = (blocks: ReadonlyArray<readonly [number, number]>): Buffer =>
  extension("IEOT", Buffer.concat([be32(1), ...blocks.map(([offset, count]) => be32(offset, count))]));

/** `EOIE`: the offset of the first extension, and the SHA-1 of the headers (name and size) of those it walks. */
export const endOfEntries = (offset: number, headers: readonly Buffer[]): Buffer =>
  extension(
    "EOIE",
    Buffer.concat([
      be32(offset),
      createHash("sha1")
        .update(Buffer.concat(headers.map((ext) => ext.subarray(0, 8))))
        .digest(),
    ]),
  );

/** `FSMN` version 2 as git writes it: a token, then an EWAH bitmap of `bitSize` bits with `words` (zero) words. */
export function fsmonitor(bitSize: number, words = 0, token = "token"): Buffer {
  const ewah = Buffer.concat([be32(bitSize, words), Buffer.alloc(8 * words), be32(0)]);
  return extension(
    "FSMN",
    Buffer.concat([be32(2), Buffer.from(`${token}\0`, "latin1"), be32(ewah.length), ewah]),
  );
}

/**
 * `UNTR`: an ident, the two stat blocks and flags (76 bytes), two object names, `.gitignore`. With `directories`, the
 * declared directory count, then a root holding `actual - 1` empty children: git 2.53 writes one pointer per directory
 * read into an array sized by the declared count, past its end when `actual` is larger (glibc then aborts).
 */
export function untrackedCache(directories?: { readonly declared: number; readonly actual: number }): Buffer {
  const ident = Buffer.from("Location /r, system Linux\0", "latin1");
  const head = [
    encodeVarint(ident.length),
    ident,
    Buffer.alloc(76 + 40),
    Buffer.from(".gitignore\0", "latin1"),
  ];
  if (directories === undefined) return extension("UNTR", Buffer.concat([...head, Buffer.alloc(1)]));
  const { declared, actual } = directories;
  const root = [encodeVarint(declared), encodeVarint(0), encodeVarint(actual - 1), Buffer.alloc(1)];
  const children = Array.from({ length: actual - 1 }, () => Buffer.from([0, 0, 0x78, 0]));
  return extension("UNTR", Buffer.concat([...head, ...root, ...children, Buffer.alloc(65)]));
}

/** `TREE` for an invalidated root (entry count -1, no subtree), as git writes it after an index change. */
export const cacheTree = (): Buffer => extension("TREE", Buffer.from("\0-1 0\n", "latin1"));

/** `REUC` for one path with three stages. */
export const resolveUndo = (path: string): Buffer =>
  extension(
    "REUC",
    Buffer.concat([
      Buffer.from([path, "100644", "100644", "100644", ""].join("\0"), "latin1"),
      Buffer.alloc(60),
    ]),
  );

const entryOf = (version: number, name: string, mode: number): Buffer =>
  version === 4 ? entryV4(encodeVarint(0), name, name.length, mode) : entryV2(name, mode);

/**
 * Review round 3, NEW-3: walked from the header, this index holds one plain file; git with `index.threads` of 3 or more
 * loads its entries from the block offsets of an `IEOT` extension that a valid `EOIE` names, and finds a gitlink
 * hidden inside a `TREE` extension. `hideEoie` puts `IEOT` and `EOIE` inside that `TREE` too, which then runs to the
 * trailer: a walk of the extension headers sees `TREE` alone, while git looks for `EOIE` at its fixed place.
 */
export function threadedGitlink(version: 2 | 3 | 4, hideEoie: boolean, hidden = "sub"): Buffer {
  const visible = entryOf(version, "a", FILE);
  const gitlink = entryOf(version, hidden, GITLINK);
  const first = HEADER_BYTES + visible.length;
  const gitlinkAt = first + 8;
  const table = offsetTable([[gitlinkAt, 1]]);
  if (!hideEoie) {
    const tree = extension("TREE", gitlink);
    const tail = Buffer.concat([tree, table, endOfEntries(first, [tree, table])]);
    return seal(Buffer.concat([header(version, 1), visible, tail]));
  }
  const tableAt = gitlinkAt + gitlink.length;
  const tree = extension("TREE", Buffer.concat([gitlink, table, endOfEntries(tableAt, [table])]));
  return seal(Buffer.concat([header(version, 1), visible, tree]));
}

export const GIT_ENV = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  LANG: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

export interface Listed {
  /** git exited 0, not killed by a signal. */
  readonly ok: boolean;
  /** Entries whose mode is a gitlink (`S_IFMT` bits 160000, as git's `S_ISGITLINK`). */
  readonly gitlinks: number;
  readonly stderr: string;
}

/** `git ls-files -s` in `top`; `threads` adds `-c index.threads=4`, the setting under which git honours EOIE and IEOT. */
export function lsFiles(top: string, home: string, threads: boolean): Listed {
  const run = spawnSync("git", [...(threads ? ["-c", "index.threads=4"] : []), "ls-files", "-s", "-z"], {
    cwd: top,
    env: GIT_ENV(home),
    encoding: "latin1",
    timeout: 10_000,
  });
  const records = run.stdout.split("\0").filter((record) => record !== "");
  const gitlinks = records.filter(
    (record) => (Number.parseInt(record.slice(0, record.indexOf(" ")), 8) & 0o170000) === GITLINK,
  ).length;
  return { ok: run.status === 0 && run.signal === null, gitlinks, stderr: run.stderr };
}
