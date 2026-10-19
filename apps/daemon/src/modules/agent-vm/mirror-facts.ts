import { closeSync, constants, fstatSync, ftruncateSync, readSync, rmSync } from "node:fs";
import { MAX_SESSION_LINE_BYTES } from "@pap/contracts";
import { existsNoFollow, openPrivate } from "./mirror-files.ts";
import { HEAD_BYTES, headIdOf } from "./mirror-line.ts";

export interface MirrorScan {
  /** The bytes of the complete lines: the size the worker is told, and the offset of the next append. */
  readonly size: number;
  /** The id of the last line, the header's included (the worker reports the same). */
  readonly lastEntryId: string | null;
  /** The id of every line, the header's included. */
  readonly ids: Set<string>;
}

const BLOCK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

function idOfParsed(text: Buffer): string | null {
  try {
    const { id } = JSON.parse(text.toString("utf8")) as { id?: unknown };
    return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Reads the mirror's file once: the id of each line, from its first 512 bytes where Pi writes `type` and `id` (a line whose
 * id is not there is parsed), and the end of the last complete line. A partial last line, left by a crash, is cut off the
 * file (Review Focus 5). `fd` is open for reading and writing.
 */
export function scanMirror(fd: number): MirrorScan {
  const ids = new Set<string>();
  let lastEntryId: string | null = null;
  const block = Buffer.allocUnsafe(BLOCK_BYTES);
  let first = true;
  let parts: Buffer[] = [];
  let collected = 0;
  let collecting = true;
  let decided = false;
  let headId: string | null = null;
  let lineBytes = 0;
  let lineEnd = 0;

  const decide = (): void => {
    headId = headIdOf(Buffer.concat(parts));
    decided = true;
    if (headId !== null && !first) {
      collecting = false;
      parts = [];
    }
  };
  const finishLine = (): void => {
    if (!decided) decide();
    const id = first || headId === null ? idOfParsed(Buffer.concat(parts)) : headId;
    first = false;
    if (id !== null) {
      ids.add(id);
      lastEntryId = id;
    }
    parts = [];
    collected = 0;
    collecting = true;
    decided = false;
    headId = null;
    lineBytes = 0;
  };
  const feed = (segment: Buffer): void => {
    lineBytes += segment.length;
    if (!collecting) return;
    parts.push(Buffer.from(segment));
    collected += segment.length;
    if (!decided && collected >= HEAD_BYTES) decide();
    // Past the bound the line cannot be one the mirror wrote: it has no id here.
    if (collecting && collected > MAX_SESSION_LINE_BYTES) {
      collecting = false;
      parts = [];
    }
  };

  for (let position = 0; ;) {
    const read = readSync(fd, block, 0, BLOCK_BYTES, position);
    if (read === 0) break;
    let from = 0;
    while (from < read) {
      const newline = block.subarray(0, read).indexOf(NEWLINE, from);
      const end = newline < 0 ? read : newline;
      feed(block.subarray(from, end));
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

const UNVERIFIED_READ_BYTES = 8 * 1024 * 1024;

/** The ids listed for the mirror at `path`; empty when there is no list, or it is a link or unreadable. */
export function unverifiedIds(path: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const sidecar = unverifiedPathOf(path);
  if (!existsNoFollow(sidecar)) return ids;
  let fd: number | null = null;
  try {
    fd = openPrivate(sidecar, constants.O_RDONLY);
    const text = Buffer.allocUnsafe(Math.min(fstatSync(fd).size, UNVERIFIED_READ_BYTES));
    readSync(fd, text, 0, text.length, 0);
    for (const line of text.toString("utf8").split("\n"))
      if (line.length > 0 && line.length <= 128) ids.add(line);
  } catch {
    ids.clear();
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return ids;
}
