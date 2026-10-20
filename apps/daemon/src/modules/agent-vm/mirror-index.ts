import { closeSync, constants, fstatSync, ftruncateSync, readSync } from "node:fs";
import { MAX_SESSION_LINE_BYTES } from "@pap/contracts";
import { existsNoFollow, openPrivate } from "./mirror-files.ts";
import { MAX_MIRROR_IDS, type MirrorScan } from "./mirror-facts.ts";

/** AVM-E29: `<name>.ids`, one record `<lineEnd> <id>\n` per line, written before the line it describes. */
export const indexPathOf = (path: string): string => `${path}.ids`;

/** The reads of a mirror's open, injectable so a test can count the bytes read. */
export type ReadAt = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;

const TAIL_BLOCK_BYTES = 4 * 1024;
/** 200 000 records of at most 16 + 1 + 128 + 1 bytes. */
const INDEX_MAX_BYTES = MAX_MIRROR_IDS * 146;
const RECORD = /^(\d{1,16}) ([A-Za-z0-9._:-]{1,128})$/;

export const indexRecord = (end: number, id: string): string => `${end} ${id}\n`;

/**
 * The end of the last complete line of the mirror, found by reading back from the end of the file (never more than the bound
 * of a line, 32 MiB + 1 bytes); a partial last line, left by a crash, is cut off the file (Review Focus 5). Null: a tail
 * longer than a line with no newline, which is not a file the mirror wrote.
 */
function completeSize(fd: number, read: ReadAt): number | null {
  const total = fstatSync(fd).size;
  const block = Buffer.allocUnsafe(TAIL_BLOCK_BYTES);
  for (let end = total; ;) {
    const start = Math.max(0, end - TAIL_BLOCK_BYTES);
    const length = end - start;
    if (length === 0) break;
    if (read(fd, block, 0, length, start) !== length) return null;
    const newline = block.subarray(0, length).lastIndexOf(0x0a);
    if (newline >= 0) {
      const size = start + newline + 1;
      if (size < total) ftruncateSync(fd, size);
      return size;
    }
    end = start;
    if (total - end > MAX_SESSION_LINE_BYTES + 1) return null;
  }
  if (total > 0) ftruncateSync(fd, 0);
  return 0;
}

/**
 * AVM-E29: the open of a mirror reads its index, not its lines. Entries whose end is past the file (a crash between the index
 * write and the line write) are ignored and cut off the index; a malformed or not strictly increasing index, or one that does
 * not end where the file does, answers null and the caller starts the mirror over. Throws past `maxIds` ids.
 */
export function loadMirrorIndex(
  fd: number,
  path: string,
  maxIds: number,
  read: ReadAt = readSync,
): MirrorScan | null {
  const size = completeSize(fd, read);
  if (size === null) return null;
  const file = indexPathOf(path);
  if (!existsNoFollow(file)) return size === 0 ? { size, lastEntryId: null, ids: new Set() } : null;
  const index = openPrivate(file, constants.O_RDWR);
  try {
    const length = fstatSync(index).size;
    if (length > INDEX_MAX_BYTES) return null;
    const text = Buffer.allocUnsafe(length);
    if (read(index, text, 0, length, 0) !== length) return null;
    const records = text.toString("latin1").split("\n");
    // A last record without its newline was cut by a crash: it was not complete, so its line is not in the file.
    records.pop();
    const ids = new Set<string>();
    let lastEnd = 0;
    let keptEnd = 0;
    let keptId: string | null = null;
    let keptBytes = 0;
    for (const record of records) {
      const match = RECORD.exec(record);
      if (match === null) return null;
      const end = Number(match[1]);
      const id = match[2] as string;
      if (end <= lastEnd) return null;
      lastEnd = end;
      if (end > size) continue;
      if (ids.has(id)) return null;
      const flat = Buffer.from(id, "latin1").toString("latin1");
      ids.add(flat);
      if (ids.size > maxIds) throw new Error("the mirror holds too many entries");
      keptEnd = end;
      keptId = flat;
      keptBytes += record.length + 1;
    }
    if (keptEnd !== size) return null;
    if (keptBytes < length) ftruncateSync(index, keptBytes);
    return { size, lastEntryId: keptId, ids };
  } finally {
    closeSync(index);
  }
}
