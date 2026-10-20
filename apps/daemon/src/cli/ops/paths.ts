import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readJsonBounded } from "../../kernel/json-bounded.ts";
import type { CliIo } from "../open-home.ts";

export { readJsonBounded };

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

/** The pid `acquireInstanceLock` wrote in `pap.lock` (`<pid> <start time>`); null when absent or unreadable. */
export function readLockPid(home: string): number | null {
  try {
    const pid = Number(readFileSync(join(home, "pap.lock"), "utf8").trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
