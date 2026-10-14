/**
 * A read-only look at git's index (`read-cache.c`, versions 2, 3 and 4) for one question (M7 ruling MC9): does it
 * record a gitlink (mode 160000)? `git status` and `git diff` run `git status` inside the nested repository of every
 * gitlink whose path holds one, and that repository's own config runs. Anything this reader is unsure of is
 * "unreadable": a bad signature or version, an entry laid out differently from what its own fields say or that git
 * refuses, a truncation, an extension outside the allowlist below, too many entries. The layout is SHA-1's: a repository with another object format asks before the index is read
 * (`extensions.objectFormat`, see git-config.ts). The differential test against real git pins this (MC11).
 */

export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_INDEX_ENTRIES = 1_000_000;

export type IndexVerdict = "clean" | "gitlink" | "unreadable";

const HEADER_BYTES = 12;
const CHECKSUM_BYTES = 20;
/** ctime, mtime, dev, ino, mode, uid, gid, size (40 bytes), the object name (20) and the flags (2). */
const FIXED_ENTRY_BYTES = 62;
const MODE_OFFSET = 24;
const FLAGS_OFFSET = 60;
const EXTENDED_FLAG = 0x4000;
/** The extended flags git knows (`CE_EXTENDED_FLAGS`: skip-worktree, intent-to-add); it dies on any other bit. */
const KNOWN_EXTENDED_FLAGS = 0x6000;
const NAME_LENGTH_MASK = 0x0fff;
const S_IFMT = 0o170000;
const S_IFGITLINK = 0o160000;
/**
 * The extensions that never change which entries git loads (M7 ruling MC11): the cache tree, resolve-undo and the
 * fsmonitor bitmap. A crafted cache tree or resolve-undo can make git die, never load another entry; the fsmonitor
 * bitmap is checked below, as git aborts on a bad one. Every other extension asks: `link` (split index) and `sdir`
 * (sparse index) move entries elsewhere, `EOIE` and `IEOT` let a threaded git load entries from other offsets, git
 * dies on an unknown lowercase one, and `UNTR` (the untracked cache, also on MC11's list) asks because git 2.53's
 * reader writes past its directory array when the payload holds more directories than it declares.
 */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(["TREE", "REUC", "FSMN"]);
/** `EOIE` (4 + 4 + 24 bytes) sits right before the trailer; git looks for it there, not by walking the extensions. */
const EOIE_BYTES = 32;

/** git's `decode_varint` (offset encoding: each continuation adds 1), or null past the end. */
function varint(
  bytes: Buffer,
  at: number,
  end: number,
): { readonly value: number; readonly next: number } | null {
  let position = at;
  if (position >= end) return null;
  let byte = bytes[position++] as number;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    // A long varint only yields a larger value than any previous name, which the caller refuses; it needs no limit.
    if (position >= end) return null;
    byte = bytes[position++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { value, next: position };
}

interface Entry {
  readonly next: number;
  readonly nameLength: number;
}

/**
 * The entry that starts at `at`, laid out as git's `create_from_disk` reads it, or null when anything disagrees with
 * the layout. Versions 2 and 3: the name length is `flags & 0xFFF` (the real length, found by the NUL, when it is
 * 0xFFF); the NUL must sit exactly there, and the entry is padded to a multiple of 8 bytes from its start. Version 4:
 * a strip length, then a suffix whose length is the name length field minus the copied prefix (or the distance to the
 * NUL when the field is 0xFFF); the NUL must sit exactly there and the strip length may not exceed the previous name.
 * Extended flags (versions 3 and 4) may hold only the bits git knows.
 */
function readEntry(
  bytes: Buffer,
  at: number,
  end: number,
  version: number,
  previousLength: number,
  onMode: (mode: number) => void,
): Entry | null {
  if (at + FIXED_ENTRY_BYTES > end) return null;
  onMode(bytes.readUInt32BE(at + MODE_OFFSET));
  const flags = bytes.readUInt16BE(at + FLAGS_OFFSET);
  const extended = (flags & EXTENDED_FLAG) !== 0;
  if (extended && version === 2) return null;
  let nameAt = at + FIXED_ENTRY_BYTES + (extended ? 2 : 0);
  if (nameAt > end) return null;
  if (extended && (bytes.readUInt16BE(nameAt - 2) & ~KNOWN_EXTENDED_FLAGS) !== 0) return null;
  if (version === 4) {
    const strip = varint(bytes, nameAt, end);
    if (strip === null || strip.value > previousLength) return null;
    nameAt = strip.next;
    // git sizes the entry from the flags name length (the whole name, copied prefix included), not from the NUL.
    const copied = previousLength - strip.value;
    const stated = flags & NAME_LENGTH_MASK;
    const nul = bytes.indexOf(0, nameAt);
    if (nul === -1 || nul >= end) return null;
    const suffix = stated < NAME_LENGTH_MASK ? stated - copied : nul - nameAt;
    if (suffix < 0 || nul !== nameAt + suffix) return null;
    if (stated === NAME_LENGTH_MASK && copied + suffix < NAME_LENGTH_MASK) return null;
    return { next: nul + 1, nameLength: copied + suffix };
  }
  const nul = bytes.indexOf(0, nameAt);
  if (nul === -1 || nul >= end) return null;
  const nameLength = nul - nameAt;
  const stated = flags & NAME_LENGTH_MASK;
  if (stated < NAME_LENGTH_MASK ? nameLength !== stated : nameLength < NAME_LENGTH_MASK) return null;
  // Versions 2 and 3 pad each entry with 1 to 8 NULs to a multiple of 8 bytes.
  const next = at + (((nul - at + 8) >> 3) << 3);
  return next > end ? null : { next, nameLength };
}

/**
 * An `FSMN` payload as git's `read_fsmonitor_extension` and `ewah_read_mmap` read it, and exactly as git writes it:
 * version 1 (a timestamp) or 2 (a NUL-terminated token), the bitmap size, then the bitmap (bit count, word count, the
 * words, the last run position) filling the payload. git aborts on more bits than entries and allocates the word count
 * before checking it, so a bitmap that is not exactly this asks.
 */
function fsmonitorReadable(bytes: Buffer, at: number, end: number, entries: number): boolean {
  if (at + 4 > end) return false;
  const version = bytes.readUInt32BE(at);
  let position = at + 4;
  if (version === 1) position += 8;
  else if (version === 2) position = bytes.indexOf(0, position) + 1;
  else return false;
  if (position <= at || position + 4 > end) return false;
  const size = bytes.readUInt32BE(position);
  position += 4;
  if (size < 12 || position + size !== end) return false;
  return bytes.readUInt32BE(position) <= entries && size === 12 + 8 * bytes.readUInt32BE(position + 4);
}

export function indexVerdict(bytes: Buffer): IndexVerdict {
  if (bytes.length < HEADER_BYTES + CHECKSUM_BYTES || bytes.length > MAX_INDEX_BYTES) return "unreadable";
  if (bytes.toString("latin1", 0, 4) !== "DIRC") return "unreadable";
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3 && version !== 4) return "unreadable";
  const count = bytes.readUInt32BE(8);
  if (count > MAX_INDEX_ENTRIES) return "unreadable";
  // git does not verify the trailer for status, diff or log (`index.skipHash` writes zeros), so neither does this.
  const end = bytes.length - CHECKSUM_BYTES;
  let gitlink = false;
  let at = HEADER_BYTES;
  let previousLength = 0;
  for (let index = 0; index < count; index++) {
    const entry = readEntry(bytes, at, end, version, previousLength, (mode) => {
      if ((mode & S_IFMT) === S_IFGITLINK) gitlink = true;
    });
    if (entry === null) return "unreadable";
    at = entry.next;
    previousLength = entry.nameLength;
  }
  // With index.threads, git takes EOIE from this fixed place (and through it IEOT) whatever the walk below finds.
  if (
    end - EOIE_BYTES >= HEADER_BYTES &&
    bytes.toString("latin1", end - EOIE_BYTES, end - EOIE_BYTES + 4) === "EOIE"
  )
    return "unreadable";
  // git's extension loop: a 4-byte signature, a 4-byte big-endian size, the payload; here it must end at the trailer.
  while (at < end) {
    if (at + 8 > end) return "unreadable";
    const name = bytes.toString("latin1", at, at + 4);
    const next = at + 8 + bytes.readUInt32BE(at + 4);
    if (!ALLOWED_EXTENSIONS.has(name) || next > end) return "unreadable";
    if (name === "FSMN" && !fsmonitorReadable(bytes, at + 8, next, count)) return "unreadable";
    at = next;
  }
  return gitlink ? "gitlink" : "clean";
}
