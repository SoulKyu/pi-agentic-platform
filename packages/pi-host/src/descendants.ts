import { readdirSync, readFileSync } from "node:fs";

/**
 * Pi's bash tool starts every command with `detached: true`, so each command leads a session and a process group
 * of its own. Signalling the worker's group (what the daemon does) never reaches them, and `process.exit` leaves
 * them running. The SDK keeps a list of them and kills it on its own signals (`killTrackedDetachedChildren`), but
 * does not export it, so the worker finds its descendants itself: on Linux through the parent pid in /proc.
 *
 * This is the cover for every way the worker ends on its own terms: shutdown, a closed channel, an orphaned
 * worker, SIGTERM, SIGHUP. For SIGKILL and the OOM killer nothing runs in the worker; the cgroup of the systemd
 * scope (M2) is the only thing that reaches these processes then.
 */
export interface ProcEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgrp: number;
}

/** The parent and group of a process from its /proc/<pid>/stat line. The command name may hold spaces and ")". */
export function parseStat(text: string): { ppid: number; pgrp: number } | null {
  const rest = text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(" ");
  const ppid = Number(rest[1]);
  const pgrp = Number(rest[2]);
  return rest.length >= 3 && Number.isInteger(ppid) && Number.isInteger(pgrp) ? { ppid, pgrp } : null;
}

export function readProcTable(): ProcEntry[] {
  const table: ProcEntry[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const stat = parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (stat) table.push({ pid, ...stat });
    } catch {
      // gone between the listing and the read
    }
  }
  return table;
}

/** Every process below `root`, children before their children, each once. */
export function descendantsOf(table: readonly ProcEntry[], root: number): ProcEntry[] {
  const found: ProcEntry[] = [];
  const seen = new Set<number>([root]);
  for (let queue = [root]; queue.length > 0;) {
    const next: number[] = [];
    for (const parent of queue) {
      for (const entry of table) {
        if (entry.ppid !== parent || seen.has(entry.pid)) continue;
        seen.add(entry.pid);
        found.push(entry);
        next.push(entry.pid);
      }
    }
    queue = next;
  }
  return found;
}

export interface CleanupEnv {
  platform: NodeJS.Platform;
  pid: number;
  readTable(): ProcEntry[];
  kill(pid: number, signal: NodeJS.Signals): void;
}

const realEnv = (): CleanupEnv => ({
  platform: process.platform,
  pid: process.pid,
  readTable: readProcTable,
  kill: (pid, signal) => void process.kill(pid, signal),
});

/**
 * SIGKILLs every descendant of this process, and the group of each descendant that leads one. Returns how many
 * descendants it signalled. Never throws.
 *
 * Only a worker that leads a group of its own (the daemon forks it `detached`) does this: run by hand in a shell it
 * touches nothing, and it never signals its own group, whose other members are not its descendants. A process id
 * can be recycled between the read of /proc and the kill; the window is a few milliseconds.
 */
function sweep({ pid, readTable, kill }: CleanupEnv): number {
  try {
    const table = readTable();
    const self = table.find((entry) => entry.pid === pid);
    if (!self || self.pgrp !== pid) return 0;
    const below = descendantsOf(table, pid);
    const leaders = new Set(below.map((entry) => entry.pid));
    const groups = [...new Set(below.map((entry) => entry.pgrp))].filter(
      (pgrp) => pgrp !== pid && leaders.has(pgrp),
    );
    const attempt = (target: number): boolean => {
      try {
        kill(target, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    };
    for (const group of groups) attempt(-group);
    return below.filter((entry) => attempt(entry.pid)).length;
  } catch {
    return 0;
  }
}

/** Processes forked while a sweep ran are found by the next one; three sweeps cover a shell and its children. */
export const MAX_SWEEPS = 3;

export function killDetachedDescendants(env: Partial<CleanupEnv> = {}): number {
  const resolved = { ...realEnv(), ...env };
  if (resolved.platform !== "linux") return 0;
  let total = 0;
  for (let round = 0; round < MAX_SWEEPS; round++) {
    const killed = sweep(resolved);
    total += killed;
    if (killed === 0) break;
  }
  return total;
}

/**
 * On SIGTERM and SIGHUP: clean up, then die of the same signal. The handler is a `once`, so the signal it raises
 * again takes its default action and the daemon still reads the exit as a signal, as it did before there was a
 * handler.
 */
export function installSignalCleanup(
  proc: NodeJS.Process = process,
  cleanup: () => unknown = killDetachedDescendants,
): void {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    proc.once(signal, () => {
      try {
        cleanup();
      } catch {
        // The worker is going down either way.
      }
      proc.kill(proc.pid, signal);
    });
  }
}
