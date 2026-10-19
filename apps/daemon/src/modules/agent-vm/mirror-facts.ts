import { closeSync, constants, fstatSync, ftruncateSync, readSync, rmSync } from "node:fs";
import { existsNoFollow, openPrivate } from "./mirror-files.ts";
import { ENTRY_ID, HEAD_BYTES, HEADER_MAX_BYTES, headIdOf } from "./mirror-line.ts";

export interface MirrorScan {
  /** The bytes of the complete lines: the size the worker is told, and the offset of the next append. */
  readonly size: number;
  /** The id of the last line, the header's included (the worker reports the same). */
  readonly lastEntryId: string | null;
  /** The id of every line, the header's included, as flat copies. */
  readonly ids: Set<string>;
}

/** AVM-E23: ids kept per mirror file; an append past it is refused `quota`, a file past it is not opened. */
export const MAX_MIRROR_IDS = 200_000;
const BLOCK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/** A copy that holds no reference to the 512-byte head it was cut from. */
const flat = (id: string): string => Buffer.from(id, "latin1").toString("latin1");

function headerIdOf(text: Buffer): string | null {
  try {
    const { id } = JSON.parse(text.toString("utf8")) as { id?: unknown };
    return typeof id === "string" && ENTRY_ID.test(id) ? flat(id) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the mirror's file once: the id of each line from its first 512 bytes, where the mirror required Pi's `type` and `id`
 * to be (AVM-E23: no line is ever parsed here but the small header). The end of the last complete line is the size; a partial
 * last line, left by a crash, is cut off the file (Review Focus 5). Throws past `maxIds` ids. `fd` is open for reading and writing.
 */
export function scanMirror(fd: number, maxIds = MAX_MIRROR_IDS): MirrorScan {
  const ids = new Set<string>();
  let lastEntryId: string | null = null;
  const block = Buffer.allocUnsafe(BLOCK_BYTES);
  let first = true;
  let head: Buffer[] = [];
  let headLength = 0;
  let lineBytes = 0;
  let lineEnd = 0;

  const finishLine = (): void => {
    const text = Buffer.concat(head);
    const id = first ? (lineBytes <= HEADER_MAX_BYTES ? headerIdOf(text) : null) : headIdOf(text);
    first = false;
    if (id !== null) {
      ids.add(flat(id));
      if (ids.size > maxIds) throw new Error("the mirror holds too many entries");
      lastEntryId = flat(id);
    }
    head = [];
    headLength = 0;
    lineBytes = 0;
  };
  const feed = (segment: Buffer): void => {
    lineBytes += segment.length;
    // The header is read whole (bounded), every other line by its head.
    const room = (first ? HEADER_MAX_BYTES : HEAD_BYTES) - headLength;
    if (room <= 0) return;
    const take = segment.subarray(0, room);
    head.push(Buffer.from(take));
    headLength += take.length;
  };

  for (let position = 0; ;) {
    const read = readSync(fd, block, 0, BLOCK_BYTES, position);
    if (read === 0) break;
    const filled = block.subarray(0, read);
    let from = 0;
    while (from < read) {
      const newline = filled.indexOf(NEWLINE, from);
      feed(filled.subarray(from, newline < 0 ? read : newline));
      if (newline < 0) break;
      finishLine();
      lineEnd = position + newline + 1;
      from = newline + 1;
    }
    position += read;
  }
  if (lineBytes > 0 && fstatSync(fd).size > lineEnd) ftruncateSync(fd, lineEnd);
  return { size: lineEnd, lastEntryId, ids };
}

/** The mirror's size and last id (a worker's hello compares them). A missing file is empty; a link at it is an error. */
export function readMirrorFacts(path: string): { size: number; lastEntryId: string | null } {
  if (!existsNoFollow(path)) return { size: 0, lastEntryId: null };
  const fd = openPrivate(path, constants.O_RDWR);
  try {
    const { size, lastEntryId } = scanMirror(fd);
    return { size, lastEntryId };
  } finally {
    closeSync(fd);
  }
}

/** `<name>.jsonl.unverified`: the ids of the user entries pap did not send, one per line, 0600 (R32). */
export const unverifiedPathOf = (path: string): string => `${path}.unverified`;

/** RT-45: removes a mirror and its unverified list. A link at either is unlinked, never followed. */
export function removeMirrorFiles(path: string): void {
  rmSync(path, { force: true });
  rmSync(unverifiedPathOf(path), { force: true });
}

/** AVM-E22: the list stays under this; an append that would pass it is refused `quota`, so a read of it is never cut short. */
export const UNVERIFIED_MAX_BYTES = 4 * 1024 * 1024;

/** The user entries pap did not send. `all`: the list cannot be trusted (unreadable, cut), so every user row counts as unsent. */
export interface Unverified {
  readonly ids: ReadonlySet<string>;
  readonly all: boolean;
}

/** The ids listed for the mirror at `path`. No list is none; one that is a link, unreadable or over its bound marks everything (fail closed). */
export function unverifiedIds(path: string): Unverified {
  const ids = new Set<string>();
  const sidecar = unverifiedPathOf(path);
  if (!existsNoFollow(sidecar)) return { ids, all: false };
  let fd: number | null = null;
  try {
    fd = openPrivate(sidecar, constants.O_RDONLY);
    const length = fstatSync(fd).size;
    if (length > UNVERIFIED_MAX_BYTES) return { ids, all: true };
    const text = Buffer.allocUnsafe(length);
    if (readSync(fd, text, 0, length, 0) !== length) return { ids, all: true };
    for (const line of text.toString("latin1").split("\n")) if (ENTRY_ID.test(line)) ids.add(line);
    return { ids, all: false };
  } catch {
    return { ids: new Set(), all: true };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
