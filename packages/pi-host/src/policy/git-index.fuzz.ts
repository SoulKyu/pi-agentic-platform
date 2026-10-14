import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cacheTree,
  encodeVarint,
  endOfEntries,
  entryV2,
  entryV4,
  extension,
  FILE,
  fsmonitor,
  GIT_ENV,
  GITLINK,
  header,
  HEADER_BYTES,
  offsetTable,
  resolveUndo,
  seal,
  threadedGitlink,
  untrackedCache,
} from "./git-index.fixtures.ts";

/**
 * Index files for the differential test against real git (M7 ruling MC11): valid indexes, real or built here, and
 * byte and field mutations of them, all drawn from a seeded generator so that a seed always gives the same file.
 */

interface Random {
  readonly int: (below: number) => number;
  readonly chance: (probability: number) => boolean;
  readonly pick: <T>(items: readonly T[]) => T;
}

/** mulberry32. */
function random(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number): number => Math.floor(next() * below);
  return {
    int,
    chance: (probability) => next() < probability,
    pick: <T>(items: readonly T[]): T => items[int(items.length)] as T,
  };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PATHS = ["a.txt", "dir/b.txt", "dir/c.txt", "dir/sub/d.txt", "lib/x.c", "lib/y.c", "z.txt"];

/**
 * Indexes written by real git, with no stat data (`update-index --index-info`), so that they are the same bytes on
 * every run: versions 2, 3 (a skip-worktree entry) and 4, each with and without a gitlink, with a cache tree; one with
 * resolve-undo; one with `EOIE` and `IEOT`.
 */
export function realBases(top: string, home: string): Buffer[] {
  const git = (input: string | null, ...args: string[]): void => {
    execFileSync("git", args, { cwd: top, env: GIT_ENV(home), input: input ?? "", stdio: "pipe" });
  };
  const read = (): Buffer => readFileSync(join(top, ".git", "index"));
  git(null, "init", "-q");
  const bases: Buffer[] = [];
  for (const version of [2, 3, 4]) {
    for (const gitlink of [false, true]) {
      git(null, "read-tree", "--empty");
      const lines = PATHS.map((path) => `100644 ${SHA} 0\t${path}\n`);
      if (gitlink) lines.push(`160000 ${SHA} 0\tvendor/lib\n`);
      git(lines.join(""), "update-index", "--index-info");
      git(null, "write-tree", "--missing-ok");
      if (version === 3) git(null, "update-index", "--skip-worktree", "lib/x.c");
      git(null, "update-index", "--index-version", String(version));
      bases.push(read());
    }
  }
  const stages = [1, 2, 3].map((stage) => `100644 ${SHA} ${stage}\tconflict.txt\n`).join("");
  git(stages, "update-index", "--index-info");
  git(null, "update-index", "--cacheinfo", `100644,${SHA},conflict.txt`);
  bases.push(read());
  const threads = ["-c", "index.threads=2", "-c", "index.recordOffsetTable=true"];
  git(null, ...threads, "-c", "index.recordEndOfIndexEntries=true", "update-index", "--index-version", "2");
  bases.push(read());
  return bases;
}

interface Built {
  readonly bytes: Buffer;
  readonly version: number;
  readonly entries: readonly number[];
  readonly extensions: readonly number[];
}

const SEGMENTS = ["a", "b", "dir", "lib", "sub", "x.c", "y.txt", "vendor"];
const MODES = [FILE, FILE, 0o100755, 0o120000, GITLINK];

/**
 * A valid index built here: sorted paths (at times one near 0xFFF bytes, where the name length field saturates), any
 * mode, stages, extended flags, the allowed extensions, at times `UNTR` or others, at times `IEOT` and `EOIE`.
 */
function synthesize(rng: Random): Built {
  const version = rng.pick([2, 3, 4]);
  const names = new Set<string>();
  const count = rng.int(7);
  while (names.size < count) {
    const depth = 1 + rng.int(3);
    const segment = (): string => (rng.chance(0.03) ? "l".repeat(4080 + rng.int(24)) : rng.pick(SEGMENTS));
    names.add(Array.from({ length: depth }, segment).join("/"));
  }
  const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const chunks: Buffer[] = [header(version, sorted.length)];
  const entries: number[] = [];
  let at = HEADER_BYTES;
  let previous = "";
  for (const name of sorted) {
    const mode = rng.pick(MODES);
    const options = {
      stage: rng.chance(0.1) ? 1 + rng.int(3) : 0,
      ...(version !== 2 && rng.chance(0.3) ? { extendedWord: rng.pick([0x4000, 0x2000, 0x6000]) } : {}),
    };
    let common = 0;
    while (common < previous.length && previous[common] === name[common]) common++;
    const entry =
      version === 4
        ? entryV4(
            encodeVarint(previous.length - common),
            name.slice(common),
            Math.min(name.length, 0xfff),
            mode,
            options,
          )
        : entryV2(name, mode, options);
    entries.push(at);
    chunks.push(entry);
    at += entry.length;
    previous = name;
  }
  const entriesEnd = at;
  const tail: Buffer[] = [];
  if (rng.chance(0.4)) tail.push(cacheTree());
  if (rng.chance(0.2)) tail.push(resolveUndo("a"));
  if (rng.chance(0.08)) tail.push(untrackedCache());
  if (rng.chance(0.25)) tail.push(fsmonitor(rng.int(sorted.length + 1), rng.int(3)));
  if (rng.chance(0.1)) tail.push(extension(rng.pick(["ZZZZ", "zzzz", "sdir", "link"]), rng.int(24)));
  const extensions: number[] = [];
  for (const ext of tail) {
    extensions.push(at);
    at += ext.length;
  }
  const body = [...chunks, ...tail];
  if (rng.chance(0.1) && sorted.length > 0) {
    // As git writes them with index.threads: one block from the first entry, then EOIE naming the first extension.
    const table = offsetTable([[HEADER_BYTES, sorted.length]]);
    extensions.push(at);
    body.push(table, endOfEntries(entriesEnd, [...tail, table]));
  }
  return { bytes: seal(Buffer.concat(body)), version, entries, extensions };
}

const BYTES = [0x00, 0xff, 0x7f, 0x80, 0x01, 0xe0, 0x0f, 0x2f];
const WORDS = [0, 1, 0x0fff, 0xffffffff, GITLINK, FILE, 0x80000000, 0x4000];
const EXTENSIONS = ["TREE", "REUC", "UNTR", "FSMN", "EOIE", "IEOT", "link", "sdir", "ZZZZ", "zzzz"];

/** One mutation of an entry or extension field of a built index, in place. */
function mutateField(rng: Random, built: Built): void {
  const { bytes, entries, extensions } = built;
  const entry = entries.length > 0 ? rng.pick(entries) : null;
  const ext = extensions.length > 0 ? rng.pick(extensions) : null;
  const flags = entry === null ? 0 : bytes.readUInt16BE(entry + 60);
  switch (rng.int(9)) {
    case 0:
      if (entry !== null)
        bytes.writeUInt32BE(rng.pick([GITLINK, 0o1160000, 0o160755, 0o40000, rng.int(2 ** 32)]), entry + 24);
      return;
    case 1:
      if (entry !== null)
        bytes.writeUInt16BE(
          (flags & 0xf000) | (((flags & 0xfff) + rng.pick([1, -1, 4095])) & 0xfff),
          entry + 60,
        );
      return;
    case 2:
      if (entry !== null) bytes.writeUInt16BE(flags ^ rng.pick([0x4000, 0x3000, 0x8000]), entry + 60);
      return;
    case 3:
      if (entry !== null && (flags & 0x4000) !== 0)
        bytes.writeUInt16BE(rng.pick([0x1000, 0x8000, 0x0001, 0x6000]), entry + 62);
      return;
    case 4:
      if (entry !== null && built.version === 4)
        bytes[entry + ((flags & 0x4000) !== 0 ? 64 : 62)] = rng.pick([0, 1, 0x7f, 0x80]);
      return;
    case 5:
      bytes.writeUInt32BE(Math.max(0, bytes.readUInt32BE(8) + rng.pick([1, -1, 2])), 8);
      return;
    case 6:
      bytes.writeUInt32BE(rng.pick([2, 3, 4]), 4);
      return;
    case 7:
      if (ext !== null)
        bytes.writeUInt32BE(Math.max(0, bytes.readUInt32BE(ext + 4) + rng.pick([1, -1, 8, -8])), ext + 4);
      return;
    default:
      if (ext !== null) bytes.write(rng.pick(EXTENSIONS), ext, "latin1");
  }
}

/** One byte-level mutation; it may change the length. */
function mutateBytes(rng: Random, bytes: Buffer): Buffer {
  const at = rng.int(bytes.length);
  const out = Buffer.from(bytes);
  switch (rng.int(8)) {
    case 0:
      out[at] = (out[at] as number) ^ (1 << rng.int(8));
      return out;
    case 1:
      out[at] = rng.pick(BYTES);
      return out;
    case 2:
      if (at + 4 <= out.length) out.writeUInt32BE(rng.pick(WORDS) >>> 0, at);
      return out;
    case 3:
      return Buffer.concat([
        out.subarray(0, at),
        Buffer.from(Array.from({ length: 1 + rng.int(8) }, () => rng.int(256))),
        out.subarray(at),
      ]);
    case 4:
      return Buffer.concat([out.subarray(0, at), out.subarray(at + 1 + rng.int(8))]);
    case 5:
      return out.subarray(0, Math.max(0, out.length - 1 - rng.int(40)));
    case 6: {
      const from = rng.int(out.length);
      return Buffer.concat([
        out.subarray(0, at),
        out.subarray(from, from + 1 + rng.int(64)),
        out.subarray(at),
      ]);
    }
    default: {
      // A file entry's mode turned into a gitlink, wherever one is found.
      const mode = out.indexOf(Buffer.from([0, 0, 0x81, 0xa4]), at);
      if (mode !== -1) out.writeUInt32BE(GITLINK, mode);
      return out;
    }
  }
}

/** The index for one seed: a real index, a built one, or a threaded-load gitlink, then up to three mutations. */
export function fuzzCase(seed: number, bases: readonly Buffer[]): Buffer {
  const rng = random(seed);
  const kind = rng.int(20);
  let bytes: Buffer;
  if (kind < 6) {
    bytes = Buffer.from(rng.pick(bases));
  } else if (kind < 17) {
    const built = synthesize(rng);
    for (let n = rng.int(3); n > 0; n--) mutateField(rng, built);
    bytes = built.bytes;
  } else {
    bytes = threadedGitlink(rng.pick([2, 3, 4] as const), rng.chance(0.5), rng.pick(["sub", "a/b", "zz"]));
  }
  for (let n = rng.chance(0.4) ? 0 : 1 + rng.int(3); n > 0; n--) bytes = mutateBytes(rng, bytes);
  return bytes;
}
