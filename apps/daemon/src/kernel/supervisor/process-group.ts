import type { Logger } from "../logger.ts";

/**
 * Signals the process group a worker leads (workers are forked `detached`, so their pid is their group id).
 * That reaches whatever shares the worker's group. It does NOT reach a child that leads a session or a group of
 * its own: Pi's bash tool starts every command that way (`detached: true`), so those are cleaned up by pi-host
 * itself when it ends, and when the worker is killed outright only the cgroup of the systemd scope (M2) covers them.
 * A group that is already gone is not an error; any other failure is logged.
 */
export function signalGroup(pid: number | undefined, signal: NodeJS.Signals, logger?: Logger): boolean {
  // kill(-1) signals every process the daemon may signal: a pid that is not a real child must never reach it.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") logger?.warn("worker_signal_failed", { pid, signal, code });
    return false;
  }
}

// Workers that have not been reaped yet, by pid. A reaped worker's pid may be recycled, so it never stays here.
const liveGroups = new Set<number>();
let exitHookInstalled = false;

/** SIGKILLs the process group of every worker that has not exited; returns how many groups it signalled. */
export function killAllWorkerGroups(): number {
  let signalled = 0;
  for (const pid of liveGroups) if (signalGroup(pid, "SIGKILL")) signalled++;
  return signalled;
}

export function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Runs when the daemon ends by itself or through process.exit(): `exit` is not emitted for a signal whose default
  // action kills the process (SIGTERM, SIGINT, SIGHUP), so the daemon's signal handlers call killAllWorkerGroups().
  process.once("exit", () => void killAllWorkerGroups());
}

export function releaseGroup(pid: number): void {
  liveGroups.delete(pid);
}
