import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

export const HEADER_MAX_BYTES = 64 * 1024;
export const HEAD_CHARS = 512;
export const READ_STEP_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface PiHeader {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL = /\p{Cc}/u;

/** A Pi session header (M4R57), or null. A line that is not JSON is simply not a header: the caller says so in its log. */
export function parseHeader(line: string): PiHeader | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const record = value as { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown } | null;
  if (typeof record !== "object" || record === null || record.type !== "session") return null;
  const { id, cwd, timestamp } = record;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.length > 4096 || CONTROL.test(cwd)) return null;
  const createdAt = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(createdAt) || createdAt < 0) return null;
  return { id, cwd, createdAt };
}

/** A regular file opened without following a link nor blocking on a FIFO (M4R56), or why not (an errno code). */
export function openRegular(
  path: string,
): { fd: number; size: number; ino: number; mtimeMs: number } | { refused: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { refused: (error as NodeJS.ErrnoException).code ?? "open_failed" };
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile()) return { fd, size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    closeSync(fd);
    return { refused: (error as NodeJS.ErrnoException).code ?? "stat_failed" };
  }
  closeSync(fd);
  return { refused: "not_file" };
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/** The first line, when its newline is within the first 64 KiB; null otherwise (not written yet, or no header). */
export function readHeaderLine(fd: number, size: number): { line: string; end: number } | null {
  const head = readAt(fd, 0, Math.min(size, HEADER_MAX_BYTES));
  const end = head.indexOf(0x0a);
  return end === -1 ? null : { line: head.toString("utf8", 0, end), end };
}

function parseLine(bytes: Buffer): Record<string, unknown> | null {
  const text = bytes.toString("utf8").trim();
  if (text === "") return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" &&
      value !== null &&
      typeof (value as { type?: unknown }).type === "string"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Counted as `bad` by the caller and said in one rate-limited log line (as Pi's own reader skips it).
    return null;
  }
}

/**
 * Complete lines from byte `from` (M4R58): about `budget` bytes of whole lines, `next` just after the last newline read.
 * An unfinished last line stays for the next read; a line over MAX_LINE_BYTES is skipped unparsed. One call reads at most
 * `budget + MAX_LINE_BYTES` bytes: stopped inside a skipped line, it answers `skipping` with `next` where it stopped, and
 * the next call (`skipping` true) goes on to that line's newline (RT-23).
 */
export function readLines(
  fd: number,
  from: number,
  size: number,
  budget = READ_STEP_BYTES,
  skipping = false,
) {
  const records: Array<Record<string, unknown>> = [];
  let bad = 0;
  let skipped = 0;
  let next = from;
  let position = from;
  let carry: Buffer[] = [];
  let carried = 0;
  let inSkip = skipping;
  const limit = budget + MAX_LINE_BYTES;
  outer: while (position < size && next - from < budget && position - from < limit) {
    const chunk = readAt(fd, position, Math.min(READ_STEP_BYTES, size - position, from + limit - position));
    if (chunk.length === 0) break;
    const chunkStart = position;
    position += chunk.length;
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      if (inSkip) {
        inSkip = false;
        skipped++;
      } else if (carried + (newline - start) > MAX_LINE_BYTES) {
        // Over the cap and ended in this chunk: never parsed either.
        skipped++;
      } else {
        const line =
          carried > 0
            ? Buffer.concat([...carry, chunk.subarray(start, newline)])
            : chunk.subarray(start, newline);
        const record = parseLine(line);
        if (record) records.push(record);
        else if (line.toString("utf8").trim() !== "") bad++;
      }
      carry = [];
      carried = 0;
      next = chunkStart + newline + 1;
      start = newline + 1;
      if (next - from >= budget) break outer;
    }
    const rest = chunk.subarray(start);
    if (inSkip || rest.length === 0) continue;
    if (carried + rest.length > MAX_LINE_BYTES) {
      inSkip = true;
      carry = [];
      carried = 0;
    } else {
      carry.push(rest);
      carried += rest.length;
    }
  }
  // Inside a line too long to keep: the next call goes on from where this one stopped, still skipping.
  if (inSkip) return { records, next: position, bad, skipped, skipping: true };
  return { records, next, bad, skipped, skipping: false };
}
