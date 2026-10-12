import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { logLineOf } from "./bounded.ts";

export interface ShutdownTimers {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const REAL: ShutdownTimers = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Stops the run, then tells extensions the session is closing, both inside one deadline. The pi CLI emits
 * `session_shutdown` on quit and `dispose()` does not (R106), so an extension holding a connection or a timer would
 * otherwise never hear of it. Whatever is left of the grace after the abort is what the handlers get; the daemon's
 * kill ladder follows 500 ms after the grace the worker was given. Never throws.
 */
export async function closeSession(
  session: AgentSession,
  graceMs: number,
  timers: ShutdownTimers = REAL,
  log: (line: string) => void = (line) => void process.stderr.write(line),
): Promise<void> {
  const deadline = timers.now() + graceMs;
  const within = (step: string, work: () => Promise<unknown>) =>
    new Promise<void>((resolve) => {
      const timer = timers.setTimer(
        () => {
          log(`pi-host: ${step} did not finish within the shutdown grace\n`);
          resolve();
        },
        Math.max(0, deadline - timers.now()),
      );
      const settle = () => {
        timers.clearTimer(timer);
        resolve();
      };
      Promise.resolve()
        .then(work)
        .then(settle, (error: unknown) => {
          log(`pi-host: ${step} failed during shutdown: ${logLineOf(error)}\n`);
          settle();
        });
    });
  await within("abort", () => session.abort());
  await within("session_shutdown", () =>
    session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
  );
}
