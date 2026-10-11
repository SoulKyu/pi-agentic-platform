import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Directories under $PAP_HOME that the daemon owns; all of them 0700. */
const HOME_DIRS = ["backups", "secrets", "logs"] as const;
const LOCK_FILE = "pap.lock";

export class InstanceLockError extends Error {
  override name = "InstanceLockError";
}

/**
 * Makes $PAP_HOME and the directories the daemon owns (0700) and sets the process umask to 077, so every file the
 * daemon creates from here on, state.db and its snapshots first, is readable by this user alone (R68). SQLite gives
 * the -wal and -shm files the mode of the database file.
 */
export function prepareHome(home: string): void {
  process.umask(0o077);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const name of HOME_DIRS) mkdirSync(join(home, name), { recursive: true, mode: 0o700 });
}

export interface InstanceLock {
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderOf(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// The lock file appears with its content already in it (hard link of a written temp file): a second instance
// that finds it never reads an empty file and mistakes it for a stale one.
function createLockFile(path: string): boolean {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

/**
 * One daemon per home (R70): two of them would migrate the same database at once. The lock is a file holding the
 * owner's pid; one whose owner is gone (a crash) is replaced. Taking over a stale lock is not atomic, so two
 * instances started within the same instant after a crash could both win: acceptable for a single-user daemon.
 */
export function acquireInstanceLock(home: string): InstanceLock {
  const path = join(home, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createLockFile(path)) {
      return {
        release() {
          if (holderOf(path) === process.pid) rmSync(path, { force: true });
        },
      };
    }
    const holder = holderOf(path);
    if (holder !== null && alive(holder)) {
      throw new InstanceLockError(
        `pap is already running on ${home} (pid ${holder}). Stop it first, or delete ${path} if that process is not pap.`,
      );
    }
    rmSync(path, { force: true });
  }
  throw new InstanceLockError(`could not take the lock ${path}`);
}
