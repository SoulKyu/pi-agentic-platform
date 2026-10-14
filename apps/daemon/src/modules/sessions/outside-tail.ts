import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** More than this of unread bytes is not parsed: it counts as tool results (a bound on one launch's work). */
export const MAX_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * Whether the bytes of a Pi file from `from` on may hold content pap did not produce (MC19 c). True for a `message`
 * entry whose message has `role: "toolResult"`, and, failing closed, for anything it cannot read: a line that is not
 * a JSON object, a last line without its newline (someone may be writing it), more than `MAX_TAIL_BYTES`, a file
 * shorter than `from`, or a file that cannot be opened. Nothing of the file is returned or logged.
 */
export function tailHoldsToolResults(path: string, from: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return true;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < from || stat.size - from > MAX_TAIL_BYTES) return true;
    if (stat.size === from) return false;
    const buffer = Buffer.alloc(stat.size - from);
    let filled = 0;
    while (filled < buffer.length) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, from + filled);
      if (n === 0) return true;
      filled += n;
    }
    if (buffer[buffer.length - 1] !== 0x0a) return true;
    for (const text of buffer.toString("utf8").split("\n")) {
      if (text.trim() === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(text);
      } catch {
        return true;
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true;
      const record = entry as { type?: unknown; message?: { role?: unknown } | null };
      if (record.type === "message" && record.message?.role === "toolResult") return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    closeSync(fd);
  }
}
