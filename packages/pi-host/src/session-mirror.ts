import { closeSync, constants, fstatSync, readSync } from "node:fs";
import { basename } from "node:path";
import {
  MAX_SESSION_LINE_BYTES,
  type SessionAppend,
  SESSION_CHUNK_BYTES,
  type DaemonToWorker,
} from "@pap/contracts";
import { logLineOf } from "./bounded.ts";
import { closeQuietly, openFileChain, openRootDir } from "./nofollow.ts";
import type { ShellTimers } from "./shell-process.ts";

/** RT-38: how long bytes that could not be sent wait for the next try. */
export const MIRROR_RETRY_MS = 2000;
const SCAN_BLOCK_BYTES = 64 * 1024;

/** The daemon's `session_resync` (the contract exports its schema, not its type). */
export type SessionResyncRequest = Pick<
  Extract<DaemonToWorker, { type: "session_resync" }>,
  "fromOffset" | "lastEntryId"
>;

export interface SessionMirrorDeps {
  /** The path of Pi's session file, or null before there is one. */
  file(): string | null;
  /** Hands one record to the gateway; false: it was not taken and the bytes stay unsent. */
  send(record: SessionAppend): boolean;
  /** Opens a file read-only without following a link at any component (`openUnderRoot`). */
  open(path: string): number;
  clock: ShellTimers;
  log(line: string): void;
}

export interface SessionMirror {
  flush(): void;
  resync(request: SessionResyncRequest): void;
  close(): void;
}

/** `open` for the mirror: every component of the path below `root` opened from its parent with O_NOFOLLOW (R26). */
export function openUnderRoot(root: string): (path: string) => number {
  return (path) => {
    const rootFd = openRootDir(root);
    try {
      return openFileChain(rootFd, root, path, constants.O_RDONLY);
    } finally {
      closeQuietly(rootFd);
    }
  };
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const count = readSync(fd, buffer, done, length - done, position + done);
    if (count === 0) break;
    done += count;
  }
  return buffer.subarray(0, done);
}

/** The id of the line that ends right before `end` (a newline), or null when there is no such line. */
function idOfLineEndingAt(fd: number, end: number): string | null {
  if (end < 1 || readAt(fd, end - 1, 1).toString("latin1") !== "\n") return null;
  const blocks: Buffer[] = [];
  let start = end - 1;
  while (start > 0 && end - start <= MAX_SESSION_LINE_BYTES) {
    const from = Math.max(0, start - SCAN_BLOCK_BYTES);
    const block = readAt(fd, from, start - from);
    const cut = block.lastIndexOf(0x0a);
    if (cut !== -1) {
      blocks.unshift(block.subarray(cut + 1));
      start = -1;
      break;
    }
    blocks.unshift(block);
    start = from;
  }
  if (start > 0) return null;
  const text = Buffer.concat(blocks).toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    const id = (parsed as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * The worker half of the transcript mirror (R1, R23, RT-38/39): sends the bytes Pi appended to its session file to the
 * daemon in chunks, and resends the file when Pi rewrote it or the daemon asks. Never throws; a failure is logged once.
 */
export function createSessionMirror(deps: SessionMirrorDeps): SessionMirror {
  let name: string | null = null;
  let inode: number | null = null;
  let sent = 0;
  let replacePending = false;
  let timer: unknown = null;
  let closed = false;
  let lastLog = "";

  const stopTimer = (): void => {
    if (timer === null) return;
    deps.clock.clearTimeout(timer);
    timer = null;
  };
  const armTimer = (): void => {
    if (timer !== null || closed) return;
    timer = deps.clock.setTimeout(() => {
      timer = null;
      flush();
    }, MIRROR_RETRY_MS);
  };
  const report = (error: unknown): void => {
    const line = `pi-host: session mirror: ${logLineOf(error)}\n`;
    if (line === lastLog) return;
    lastLog = line;
    deps.log(line);
  };

  function openCurrent(path: string): number | null {
    try {
      return deps.open(path);
    } catch (error) {
      // A file Pi has not written yet is not a failure; anything else (a link, a FIFO, a permission) is logged.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(error);
      return null;
    }
  }

  // Follows the file Pi writes: another name starts over without replace, a smaller or replaced file starts over with it.
  function track(path: string, fd: number): number {
    const stat = fstatSync(fd);
    const next = basename(path);
    if (next !== name) {
      name = next;
      sent = 0;
      replacePending = false;
    } else if (stat.size < sent || (inode !== null && stat.ino !== inode)) {
      sent = 0;
      replacePending = true;
    }
    inode = stat.ino;
    return stat.size;
  }

  function sendFrom(fd: number, size: number): void {
    while (sent < size || replacePending) {
      const chunk = readAt(fd, sent, Math.min(SESSION_CHUNK_BYTES, size - sent));
      if (chunk.length === 0 && !replacePending) break;
      const accepted = deps.send({
        type: "session_append",
        file: name as string,
        offset: sent,
        data: chunk.toString("base64"),
        replace: replacePending,
      });
      if (!accepted) {
        armTimer();
        return;
      }
      sent += chunk.length;
      replacePending = false;
    }
  }

  function flush(): void {
    const path = deps.file();
    if (closed || path === null) return;
    const fd = openCurrent(path);
    if (fd === null) return;
    try {
      sendFrom(fd, track(path, fd));
      if (timer !== null && !replacePending && sent >= fstatSync(fd).size) stopTimer();
    } catch (error) {
      report(error);
      armTimer();
    } finally {
      closeSync(fd);
    }
  }

  return {
    flush,
    resync(request) {
      const path = deps.file();
      if (closed || path === null) return;
      const fd = openCurrent(path);
      if (fd === null) return;
      try {
        const size = track(path, fd);
        const { fromOffset, lastEntryId } = request;
        const prefix =
          fromOffset > 0 &&
          fromOffset <= size &&
          lastEntryId !== null &&
          idOfLineEndingAt(fd, fromOffset) === lastEntryId;
        sent = prefix ? fromOffset : 0;
        replacePending = !prefix;
        sendFrom(fd, size);
      } catch (error) {
        report(error);
        armTimer();
      } finally {
        closeSync(fd);
      }
    },
    close() {
      flush();
      closed = true;
      stopTimer();
    },
  };
}
