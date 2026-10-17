import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** How long an empty `op.lock` counts as a holder still writing its line. */
const EMPTY_FILE_GRACE_MS = 5000;

export class OpLockBusy extends Error {
  override name = "OpLockBusy";
}

/** Field 22 of /proc/<pid>/stat (start time in ticks): with the pid it names one process, so a recycled pid is not mistaken for the holder. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** Test seams for the two windows of the check-then-act: after `wx` failed and before the read, and after the verdict "stale" and before the removal. */
export interface OpLockHooks {
  readonly afterCollision?: () => void;
  readonly beforeRemove?: () => void;
}

/**
 * One update, rollback, recover or restore at a time per home: `update/op.lock` holds `<pid> <start time>`, created with `wx`.
 * A file whose process is gone (or whose pid now belongs to another process) is stale and replaced. Returns the release function.
 */
export function acquireOpLock(
  home: string,
  pid = process.pid,
  startOf: (pid: number) => string | null = processStart,
  hooks: OpLockHooks = {},
): () => void {
  const dir = join(home, "update");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "op.lock");
  const mine = `${pid} ${startOf(pid) ?? ""}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(path, "utf8") === mine) rmSync(path, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    hooks.afterCollision?.();
    let text: string;
    let age: number;
    try {
      text = readFileSync(path, "utf8");
      age = Date.now() - statSync(path).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // released between our open and our read
      throw error;
    }
    // A holder creates the file with `wx` and writes its line a moment later: a young empty file is a holder mid-write, not a stale one.
    if (text === "" && age < EMPTY_FILE_GRACE_MS) break;
    const [holder, started = ""] = text.trim().split(" ");
    const owner = Number(holder);
    if (Number.isInteger(owner) && owner > 0 && startOf(owner) !== null && startOf(owner) === started)
      throw new OpLockBusy(`another pap update, rollback, recover or restore is running (pid ${owner})`);
    // Two acquirers can both judge the same file stale: only remove it if it is still the file we judged.
    hooks.beforeRemove?.();
    try {
      if (readFileSync(path, "utf8") === text) rmSync(path, { force: true });
    } catch {
      // gone already
    }
  }
  throw new OpLockBusy("another pap update, rollback, recover or restore is starting");
}
