import { type ChildProcess, type spawn, type StdioOptions } from "node:child_process";
import { EGRESS_ENV } from "@pap/contracts";
import { type EnvSource, NETWORK_ENV, TOOLING_ENV, unattendedEnv } from "../../kernel/child-env.ts";
import type { ScopeLaunch } from "../../kernel/supervisor/scope.ts";

export const PRECHECK_TIMEOUT_MS = 30_000;
export const PRECHECK_KILL_GRACE_MS = 2_000;
export const PRECHECK_OUTPUT_BYTES = 4_096;

/**
 * The precheck's whole environment (owner c7, m10q7, M10R151): M9's allowlist, the proxies and CA bundles, `TMPDIR` and
 * `XDG_*`, and the names the trigger lists. A never-passed name (the SSH agent, provider keys, forge tokens) stays out
 * even when listed; nothing is `set`.
 */
export function precheckEnv(
  base: EnvSource,
  names: readonly string[],
  agent?: { readonly proxied: boolean },
): Record<string, string> {
  // An agent's precheck runs in its sandbox: the owner's proxy variables never reach it, pap's own proxy only when it has network.
  if (agent)
    return unattendedEnv(base, { keep: [...TOOLING_ENV, ...names], set: agent.proxied ? EGRESS_ENV : {} });
  return unattendedEnv(base, { keep: [...NETWORK_ENV, ...TOOLING_ENV, ...names] });
}

export interface PrecheckSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/**
 * `/bin/sh -c <command>`: the owner's command as saved, never with payload text in it. `env` is
 * `precheckEnv(process.env, trigger.execution.env)`. A systemd scope (`scopes.next({ kind: "terminal" })`, agreement 9)
 * goes in front of the shell. `wrap` (an agent trigger's sandbox, M11R68) replaces the shell with `[bwrap, ...argv]`.
 */
export function precheckSpec(
  command: string,
  env: Record<string, string>,
  scope: ScopeLaunch | null,
  wrap?: (command: string) => string[],
): PrecheckSpec {
  const shell = wrap ? wrap(command) : ["/bin/sh", "-c", command];
  return {
    file: scope ? scope.command : (shell[0] as string),
    args: scope ? [...scope.args, ...shell] : shell.slice(1),
    env: { ...env, ...(scope?.env ?? {}) },
  };
}

export type PrecheckOutcome =
  | { readonly verdict: "fire"; readonly output: string; readonly durationMs: number }
  | {
      readonly verdict: "skip";
      readonly reason: string;
      readonly output: string;
      readonly durationMs: number;
    }
  | {
      readonly verdict: "error";
      readonly code: "exit" | "timeout" | "spawn" | "signal" | "aborted";
      readonly exitCode: number | null;
      readonly durationMs: number;
    };

/** The last `max` bytes; a multi-byte character cut at the front is dropped by the decoder. */
function tail(max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk: Buffer) {
      chunks.push(chunk);
      size += chunk.byteLength;
      while (size > max) {
        const first = chunks[0] as Buffer;
        const excess = size - max;
        if (first.byteLength <= excess) {
          chunks.shift();
          size -= first.byteLength;
        } else {
          chunks[0] = first.subarray(excess);
          size -= excess;
        }
      }
    },
    text: () => new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)).replace(/^�+/, ""),
  };
}

// Bidi, zero-width and control characters go before a line of the output is shown in the journal.
export const firstLine = (text: string): string =>
  [...(text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")]
    .slice(0, 120)
    .join("");

/** kernel/supervisor/process-group.ts: the group is known to `killAllWorkerGroups()` (stop, `exit`) while it lives. */
export interface PrecheckGroups {
  track(pid: number): void;
  signal(pid: number, signal: NodeJS.Signals): void;
  release(pid: number): void;
}

export interface PrecheckDeps {
  readonly spawn: typeof spawn;
  /** M8 MC38: every PTY master is masked in the child (kernel/pty/fd-mask.ts `maskedStdio`). */
  stdio(): StdioOptions;
  readonly now: () => number;
  /** The kernel Clock: `setTimeout` / `clearTimeout`. */
  setTimer(fn: () => void, ms: number): { cancel(): void };
  readonly groups: PrecheckGroups;
}

/**
 * Exit 0 fires, exit 1 skips (the first line of the output is the reason), anything else is an error (C §6.4).
 * `signal` (the outbox handler's deadline, `automation.stop()`) starts the same kill ladder as the timeout.
 */
export function runPrecheck(
  spec: PrecheckSpec,
  cwd: string,
  deps: PrecheckDeps,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<PrecheckOutcome> {
  const started = deps.now();
  if (options.signal?.aborted)
    return Promise.resolve({ verdict: "error", code: "aborted", exitCode: null, durationMs: 0 });
  const out = tail(PRECHECK_OUTPUT_BYTES);
  const err = tail(PRECHECK_OUTPUT_BYTES);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = deps.spawn(spec.file, [...spec.args], {
        cwd,
        env: spec.env,
        detached: true,
        stdio: deps.stdio(),
      });
    } catch {
      resolve({ verdict: "error", code: "spawn", exitCode: null, durationMs: 0 });
      return;
    }
    const pid = child.pid !== undefined && child.pid > 1 ? child.pid : null;
    if (pid !== null) deps.groups.track(pid);
    child.stdin?.end();
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    let stopped: "timeout" | "aborted" | null = null;
    let grace: { cancel(): void } | null = null;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const kill = (signal: NodeJS.Signals) => {
      if (pid !== null) deps.groups.signal(pid, signal);
    };
    const ladder = (why: "timeout" | "aborted") => {
      if (stopped !== null || exit !== null) return;
      stopped = why;
      kill("SIGTERM");
      grace = deps.setTimer(() => {
        kill("SIGKILL");
        // A shell SIGKILL does not end (a process stuck in the kernel) must not hold the slot for ever: after one more
        // grace the answer is the stop reason, the pipes are dropped, and the group stays tracked for the exit hook.
        grace = deps.setTimer(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(verdict(), { keepTracked: true });
        }, PRECHECK_KILL_GRACE_MS);
      }, PRECHECK_KILL_GRACE_MS);
    };
    const deadline = deps.setTimer(() => ladder("timeout"), options.timeoutMs ?? PRECHECK_TIMEOUT_MS);
    const onAbort = () => ladder("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let drain: { cancel(): void } | null = null;
    let settled = false;
    const finish = (result: PrecheckOutcome, how: { keepTracked?: boolean } = {}) => {
      if (settled) return;
      settled = true;
      deadline.cancel();
      grace?.cancel();
      drain?.cancel();
      options.signal?.removeEventListener("abort", onAbort);
      if (pid !== null && !how.keepTracked) deps.groups.release(pid);
      resolve(result);
    };
    const verdict = (): PrecheckOutcome => {
      const durationMs = deps.now() - started;
      const code = exit?.code ?? null;
      if (stopped !== null) return { verdict: "error", code: stopped, exitCode: code, durationMs };
      if (exit?.signal) return { verdict: "error", code: "signal", exitCode: null, durationMs };
      if (code === 0) return { verdict: "fire", output: out.text(), durationMs };
      if (code === 1)
        return {
          verdict: "skip",
          reason: firstLine(out.text() || err.text()),
          output: out.text(),
          durationMs,
        };
      return { verdict: "error", code: "exit", exitCode: code, durationMs };
    };
    child.on("error", () =>
      finish({ verdict: "error", code: "spawn", exitCode: null, durationMs: deps.now() - started }),
    );
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      deadline.cancel();
      // What the shell left in its group (a `cmd &`) goes now; its pipes then close.
      kill("SIGKILL");
      // A job that left the group (`setsid`) may still hold a pipe: the output is taken as it is after the grace.
      drain = deps.setTimer(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(verdict());
      }, PRECHECK_KILL_GRACE_MS);
    });
    child.on("close", (code, signal) => {
      exit ??= { code, signal };
      finish(verdict());
    });
  });
}
