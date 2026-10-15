import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { LANE_LIMITS, PapError, type ScriptKind } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import { SCRIPT_LOG_BYTES } from "./script-spawn.ts";

export const CUT_LINE = "[pap: log cut at 5 MiB]";
const CUT_TEXT = Buffer.from(`\n${CUT_LINE}\n`);
/** A lane id is a path segment here: only this shape ever reaches a path (the store's own ids are 6 to 53 of these). */
const LANE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const dirOf = (home: string, laneId: string): string => {
  if (!LANE_ID.test(laneId)) throw new PapError("not_found");
  return join(home, "lanes", laneId);
};

export interface LogSink {
  write(chunk: Buffer): void;
  /** Closes the file; `bytes` is everything the script wrote, the cut part included. */
  close(): { bytes: number };
}

/**
 * `$PAP_HOME/lanes/<laneId>/<kind>.log`: folder 0700, file 0600, replacing the kind's earlier log (M9R29). `keep` appends
 * instead: the first setup of a lane follows the copy step's lines in the same log (Task 6b).
 */
export function openLog(
  home: string,
  laneId: string,
  kind: ScriptKind,
  logger: Logger,
  keep = false,
): LogSink {
  const dir = dirOf(home, laneId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, "lanes"), 0o700);
  chmodSync(dir, 0o700);
  const fd = openSync(
    join(dir, `${kind}.log`),
    constants.O_WRONLY |
      constants.O_CREAT |
      (keep ? constants.O_APPEND : constants.O_TRUNC) |
      constants.O_NOFOLLOW,
    0o600,
  );
  let seen = 0;
  // The 5 MiB cap counts the lines already there.
  let written = keep ? fstatSync(fd).size : 0;
  let cut = false;
  let failed = false;
  let closed = false;
  const put = (data: Buffer): void => {
    if (failed) return;
    try {
      let at = 0;
      while (at < data.length) at += writeSync(fd, data, at, data.length - at);
      written += data.length;
    } catch (error) {
      // A full disk stops the log, not the script (M9R29): said once, with the code only.
      failed = true;
      logger.warn("lane_script_log_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  };
  return {
    write(chunk) {
      if (closed) return;
      seen += chunk.length;
      if (cut) return;
      const room = SCRIPT_LOG_BYTES - written;
      if (chunk.length <= room) return put(chunk);
      put(chunk.subarray(0, room));
      put(CUT_TEXT);
      cut = true;
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
      return { bytes: seen };
    },
  };
}

/** A lane's logs go with its folder (archive, M9-RT-22). */
export function deleteLogs(home: string, laneId: string): void {
  rmSync(dirOf(home, laneId), { recursive: true, force: true });
}

/** How many leading bytes of `buffer` end on a character boundary; a complete end keeps everything. */
export function utf8Keep(buffer: Buffer): number {
  for (let at = buffer.length - 1; at >= Math.max(0, buffer.length - 4); at--) {
    const byte = buffer[at] as number;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return at + need > buffer.length ? at : buffer.length;
  }
  return buffer.length;
}

/** The last `max` bytes of a log, from a character boundary; "" when there is none (the archive refusal shows it). */
export function tailLog(home: string, laneId: string, kind: ScriptKind, max: number): string {
  let fd: number;
  try {
    fd = openSync(join(dirOf(home, laneId), `${kind}.log`), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const raw = Buffer.alloc(Math.min(size, max));
    const got = readSync(fd, raw, 0, raw.length, size - raw.length);
    let from = 0;
    while (from < 3 && from < got && ((raw[from] as number) & 0xc0) === 0x80) from++;
    return raw.subarray(size > max ? from : 0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface LogChunk {
  readonly text: string;
  readonly nextOffset: number | null;
  readonly size: number;
  readonly capped: boolean;
}

export interface LogReaderDeps {
  readonly home: string;
  /** The owner of a lane, or undefined when there is no such lane. */
  ownerOf(laneId: string): string | undefined;
}

const EMPTY: LogChunk = { text: "", nextOffset: null, size: 0, capped: false };

/** Another owner's lane, and a lane that is not there, are both `not_found`. */
export function readLog(
  deps: LogReaderDeps,
  ownerId: string,
  laneId: string,
  kind: ScriptKind,
  offset: number,
): LogChunk {
  if (deps.ownerOf(laneId) !== ownerId) throw new PapError("not_found");
  const path = join(dirOf(deps.home, laneId), `${kind}.log`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw new PapError("internal");
  }
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, CUT_TEXT.length));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    const capped = tail.equals(CUT_TEXT);
    if (offset >= size) return { text: "", nextOffset: null, size, capped };
    const raw = Buffer.alloc(Math.min(LANE_LIMITS.logChunkBytes, size - offset));
    const got = readSync(fd, raw, 0, raw.length, offset);
    let data = raw.subarray(0, got);
    // An offset inside a character starts at the next one.
    let skipped = 0;
    while (offset > 0 && skipped < 3 && skipped < data.length && ((data[skipped] as number) & 0xc0) === 0x80)
      skipped++;
    data = data.subarray(skipped);
    const more = offset + skipped + data.length < size;
    const keep = more ? utf8Keep(data) : data.length;
    const end = offset + skipped + keep;
    return {
      text: data.subarray(0, keep).toString("utf8"),
      nextOffset: end < size ? end : null,
      size,
      capped,
    };
  } finally {
    closeSync(fd);
  }
}
