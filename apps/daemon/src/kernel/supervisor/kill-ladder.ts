import type { Clock, TimerHandle } from "../clock.ts";
import type { WorkerExit } from "./exit.ts";

export const SHUTDOWN_GRACE_MS = 2000;
/** What the worker is told to wait for: less than the ladder waits for it, so SIGTERM never cuts a graceful stop short. */
export const WORKER_SHUTDOWN_GRACE_MS = 1500;
export const SIGTERM_GRACE_MS = 3000;
/** SIGKILL cannot be caught, but a process stuck in the kernel can outlive it: the ladder still ends. */
export const SIGKILL_WAIT_MS = 5000;

export interface LadderTarget {
  shutdown(graceMs: number): void;
  signal(signal: "SIGTERM" | "SIGKILL"): boolean;
  readonly exited: Promise<WorkerExit>;
}

async function exitsWithin(exited: Promise<WorkerExit>, ms: number, clock: Clock): Promise<boolean> {
  let timer: TimerHandle | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = clock.setTimeout(() => resolve(false), ms);
  });
  const result = await Promise.race([exited.then(() => true as const), timeout]);
  if (timer) clock.clearTimeout(timer);
  return result;
}

// A rung that throws (a closed channel, a signal refused) must not stop the next one.
function attempt(rung: () => unknown): void {
  try {
    rung();
  } catch {
    // the next rung still applies
  }
}

export async function killLadder(target: LadderTarget, clock: Clock): Promise<WorkerExit> {
  attempt(() => target.shutdown(SHUTDOWN_GRACE_MS));
  if (await exitsWithin(target.exited, SHUTDOWN_GRACE_MS, clock)) return target.exited;
  attempt(() => target.signal("SIGTERM"));
  if (await exitsWithin(target.exited, SIGTERM_GRACE_MS, clock)) return target.exited;
  attempt(() => target.signal("SIGKILL"));
  if (await exitsWithin(target.exited, SIGKILL_WAIT_MS, clock)) return target.exited;
  return { code: null, signal: "SIGKILL", cause: "killed" };
}
