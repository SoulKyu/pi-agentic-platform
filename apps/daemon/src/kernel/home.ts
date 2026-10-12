import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Directories under $PAP_HOME that the daemon owns; all of them 0700. */
const HOME_DIRS = ["backups", "secrets", "logs", "exports"] as const;
/** The database and the files SQLite keeps next to it: 0600, whatever an earlier run left them as. */
const DATABASE_FILES = ["state.db", "state.db-wal", "state.db-shm"] as const;
const LOCK_FILE = "pap.lock";
/** What link(2) answers on a file system without hard links; any other code has some other cause. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK"]);

export class InstanceLockError extends Error {
  override name = "InstanceLockError";
}

export class HomeError extends Error {
  override name = "HomeError";
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "unknown";

// The umask the process had before the daemon first changed it: the one the user's tools are meant to run under.
let original: number | undefined;

/**
 * `follow: false` leaves a symlink alone: a chmod through a linked database file would change the mode of whatever
 * it points to, which is not ours. The home itself and its directories are followed (a symlinked $PAP_HOME is a
 * supported layout).
 */
function makePrivate(path: string, wanted: number, follow: boolean): void {
  try {
    const stat = follow ? statSync(path) : lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if ((stat.mode & 0o077) !== 0) chmodSync(path, wanted);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw new HomeError(
      `cannot make ${path} private (${wanted.toString(8).padStart(4, "0")}): ${codeOf(error)}`,
    );
  }
}

/**
 * Makes $PAP_HOME and the directories the daemon owns (0700) and sets the process umask to 077, so every file the
 * daemon creates from here on, state.db and its snapshots first, is readable by this user alone (R68). SQLite gives
 * the -wal and -shm files the mode of the database file. What an earlier run left more open is tightened.
 *
 * Returns the umask the process had before the first call (R114b): the workers run their tools under it, not under 077.
 */
export function prepareHome(home: string): number {
  const previous = process.umask(0o077);
  original ??= previous;
  const dirs = [home, ...HOME_DIRS.map((name) => join(home, name))];
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new HomeError(`cannot create ${dir}: ${codeOf(error)}`);
    }
    makePrivate(dir, 0o700, true);
  }
  for (const name of DATABASE_FILES) makePrivate(join(home, name), 0o600, false);
  return original;
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
    return codeOf(error) === "EPERM";
  }
}

/**
 * When the process started, in clock ticks since boot (field 22 of /proc/<pid>/stat); null where there is no /proc.
 * A pid alone can name a different process after a reboot or a wrap-around: pid and start time cannot.
 */
export function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name comes first, in parentheses, and may hold spaces and parentheses itself.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return /^\d+$/.test(fields[19] ?? "") ? (fields[19] ?? null) : null;
  } catch {
    return null;
  }
}

interface Holder {
  readonly pid: number;
  readonly startTime: string | null;
}

function holderOf(path: string): Holder | null {
  try {
    const [pidText = "", startTime = ""] = readFileSync(path, "utf8").trim().split(/\s+/);
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startTime: /^\d+$/.test(startTime) ? startTime : null };
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

// The lock paths this process holds. A lock that names our own pid but is not in here was left by an earlier run:
// in an OCI container the daemon is pid 1 every time, so "alive" would be true for ever (R116).
const held = new Set<string>();

function running(holder: Holder, path: string): boolean {
  if (holder.pid === process.pid) return held.has(path);
  if (!alive(holder.pid)) return false;
  const now = holder.startTime === null ? null : startTimeOf(holder.pid);
  return now === null || now === holder.startTime;
}

// The lock file appears with its content already in it (hard link of a written temp file): a second instance
// that finds it never reads an empty file and mistakes it for a stale one.
function createLockFile(path: string): boolean {
  const temp = `${path}.${process.pid}.tmp`;
  const start = startTimeOf(process.pid);
  try {
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, `${process.pid}${start === null ? "" : ` ${start}`}\n`);
    } finally {
      closeSync(fd);
    }
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (codeOf(error) === "EEXIST") return false;
    const code = codeOf(error);
    const hint = NO_HARD_LINKS.has(code) ? " $PAP_HOME needs a file system that allows hard links." : "";
    throw new InstanceLockError(`cannot create the lock file ${path} (${code}).${hint}`);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * One daemon per home (R70): two of them would migrate the same database at once. The lock is a file holding the
 * owner's pid and start time; one whose owner is gone (a crash, a reboot, a container restart) is replaced. Taking
 * over a stale lock is not atomic, so two instances started within the same instant after a crash could both win:
 * acceptable for a single-user daemon.
 */
export function acquireInstanceLock(home: string): InstanceLock {
  const path = join(home, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createLockFile(path)) {
      held.add(path);
      return {
        release() {
          held.delete(path);
          if (holderOf(path)?.pid === process.pid) rmSync(path, { force: true });
        },
      };
    }
    const holder = holderOf(path);
    if (holder !== null && running(holder, path)) {
      throw new InstanceLockError(
        `pap is already running on ${home} (pid ${holder.pid}). Stop it first, or delete ${path} if that process is not pap.`,
      );
    }
    rmSync(path, { force: true });
  }
  throw new InstanceLockError(`could not take the lock ${path}`);
}
