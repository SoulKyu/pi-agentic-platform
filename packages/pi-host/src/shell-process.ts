import type { ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as osConstants } from "node:os";
import { clipUnits, MAX_ID_LENGTH } from "./policy/trail.ts";
import type { Redactor } from "./policy/redact.ts";
import { addStreamCount, createStreamRedactor } from "./redact-stream.ts";

/** Pi's `BashOperations` shape (`@earendil-works/pi-coding-agent`), repeated so this file has no SDK import. */
export interface ShellOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
}

/** The id of the tool call whose `execute` is running: Pi passes none to `operations.exec` (set by `createSandboxTool`). */
export const toolCall = new AsyncLocalStorage<string>();

/** The worker's timer seam (tests drive the tool timeout without sleeping). */
export interface ShellTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const SYSTEM_TIMERS: ShellTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
/** What `setTimeout` takes: a longer delay fires at once (Node's overflow), which would kill a command the model gave a day. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const killGroup = (pid: number | undefined): void => {
  // Never `process.kill(-0)` or `-1`: those are this process group and every process the user owns.
  if (pid === undefined || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
};

export type ShellCallOptions = Parameters<ShellOperations["exec"]>[2];

/**
 * One command as a child process group: the timeout check, the redacted stream, Stop and timeout killing the whole group,
 * and a call that always settles. `start` spawns (a throw is a failed command); `after` runs once the child is gone, or
 * when nothing started, and before the call settles.
 */
export function runShellProcess(
  start: () => ChildProcess,
  { onData, signal, timeout }: ShellCallOptions,
  deps: { readonly timers: ShellTimers; readonly redact?: () => Redactor },
  after: () => Promise<void>,
  afterThen: (after: () => Promise<void>, then: () => void) => void,
): Promise<{ exitCode: number | null }> {
  const { timers } = deps;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      if (
        timeout !== undefined &&
        !(Number.isFinite(timeout) && timeout > 0 && timeout * 1000 <= MAX_TIMER_MS)
      )
        throw new Error("Invalid timeout: must be a finite number of seconds");
      child = start();
    } catch (error) {
      afterThen(after, () => reject(error));
      return;
    }
    const callId = toolCall.getStore();
    // One stream per pipe: each has its own decoder, and a multi-byte character never spans the two.
    const streams = deps.redact
      ? [createStreamRedactor(deps.redact), createStreamRedactor(deps.redact)]
      : null;
    const hand = (index: 0 | 1) => (data: Buffer) => {
      const safe = streams ? (streams[index]?.push(data) ?? data) : data;
      if (safe.length > 0) onData(safe);
    };
    let timedOut = false;
    const timer =
      timeout !== undefined
        ? timers.setTimeout(() => {
            timedOut = true;
            killGroup(child.pid);
          }, timeout * 1000)
        : undefined;
    const onAbort = () => killGroup(child.pid);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Aborted while the proxy was being asked: the listener above would never hear it.
    if (signal?.aborted) onAbort();
    const finish = () => {
      if (timer !== undefined) timers.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const stream of streams ?? []) {
        const rest = stream.flush();
        if (rest.length > 0) onData(rest);
      }
      if (streams && callId !== undefined)
        addStreamCount(
          clipUnits(callId, MAX_ID_LENGTH),
          streams.reduce((sum, stream) => sum + stream.count(), 0),
        );
    };
    child.stdout?.on("data", hand(0));
    child.stderr?.on("data", hand(1));
    // An error and a close can both come for one child: the first ends the call, `after` runs once.
    let ended = false;
    child.once("error", (error) => {
      if (ended) return;
      ended = true;
      finish();
      afterThen(after, () => reject(error));
    });
    child.once("close", (code, signalName) => {
      if (ended) return;
      ended = true;
      finish();
      afterThen(after, () => {
        if (signal?.aborted) return reject(new Error("aborted"));
        if (timedOut) return reject(new Error(`timeout:${timeout}`));
        resolve({
          exitCode: code ?? (signalName ? 128 + (osConstants.signals[signalName] ?? 0) : 1),
        });
      });
    });
  });
}
