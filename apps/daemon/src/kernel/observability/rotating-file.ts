import { closeSync, constants, fstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

const MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface RotatingFile {
  /** Appends the line and a newline. Throws when the file cannot be written; a line it refuses is dropped and counted. */
  append(line: string): void;
  /** Lines refused so far: over 16 KiB, or holding a line break. */
  dropped(): number;
  close(): void;
}

/**
 * An append-only text file for lines shipped elsewhere (`logs/runs.jsonl`, spec C §3.4): created 0600, never opened
 * through a symlink, rotated at `maxBytes` to `.1` … `.keep` with the oldest dropped. Synchronous, so a line is on disk
 * before the caller goes on. The file is opened at the first append, not at creation.
 */
export function createRotatingFile(options: {
  readonly path: string;
  readonly maxBytes?: number;
  readonly keep?: number;
}): RotatingFile {
  const { path } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? 9;
  let fd: number | null = null;
  let size = 0;
  let refused = 0;

  function open(): number {
    // O_NOFOLLOW: a symlink planted at the path is an error (ELOOP), never a write through it.
    const opened = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      size = fstatSync(opened).size;
    } catch (error) {
      closeSync(opened);
      throw error;
    }
    return opened;
  }

  function rotate(): void {
    if (fd !== null) closeSync(fd);
    fd = null;
    rmSync(`${path}.${keep}`, { force: true });
    for (let n = keep - 1; n >= 1; n--) renameIfThere(`${path}.${n}`, `${path}.${n + 1}`);
    renameIfThere(path, `${path}.1`);
  }

  return {
    append(line) {
      const bytes = Buffer.from(`${line}\n`, "utf8");
      if (bytes.length - 1 > MAX_LINE_BYTES || /[\n\r]/.test(line)) {
        refused++;
        return;
      }
      fd ??= open();
      if (size > 0 && size + bytes.length > maxBytes) {
        rotate();
        fd = open();
      }
      writeSync(fd, bytes);
      size += bytes.length;
    },
    dropped: () => refused,
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

function renameIfThere(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
