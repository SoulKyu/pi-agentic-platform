import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";
import type { CliIo } from "../open-home.ts";

/** The app folder of an archive install: `releases/<id>`, `current`, `downloads/`. */
export const installRoot = (io: Pick<CliIo, "homedir">): string => join(io.homedir, ".local", "share", "pap");

/** Where updates keep `pending.json`, `op.lock`, `last-check.json` and `last-backup.json`. */
export const opsDir = (home: string): string => join(home, "update");

/** Parent 0700, file 0600, flushed, then renamed over the target: a reader sees the old file or the new one. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const text = `${JSON.stringify(value)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** null: absent. "damaged": not a regular file, above `maxBytes`, not JSON or not the shape. Never throws for content. */
export function readJsonBounded<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes: number,
): T | "damaged" | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "damaged";
  }
  try {
    if (!fstatSync(fd).isFile()) return "damaged";
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) return "damaged";
    }
    const parsed = schema.safeParse(JSON.parse(buffer.toString("utf8", 0, length)));
    return parsed.success ? parsed.data : "damaged";
  } catch {
    return "damaged";
  } finally {
    closeSync(fd);
  }
}

/** The pid `acquireInstanceLock` wrote in `pap.lock` (`<pid> <start time>`); null when absent or unreadable. */
export function readLockPid(home: string): number | null {
  try {
    const pid = Number(readFileSync(join(home, "pap.lock"), "utf8").trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
