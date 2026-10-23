import { spawn } from "node:child_process";
import type { Clock } from "../../kernel/clock.ts";
import type { EnvSource } from "../../kernel/child-env.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Span } from "../../kernel/observability/tracer.ts";
import { maskedStdio } from "../../kernel/pty/fd-mask.ts";
import { releaseGroup, signalGroup, trackGroup } from "../../kernel/supervisor/process-group.ts";
import type { WorkerScopes } from "../../kernel/supervisor/scope.ts";
import {
  type PrecheckDeps,
  type PrecheckOutcome,
  precheckEnv,
  precheckSpec,
  runPrecheck,
} from "./precheck.ts";
import { createPrecheckQueue, type PrecheckQueue } from "./precheck-queue.ts";
import type { PrecheckInput, PrecheckPort, PrecheckRun } from "./precheck-step.ts";

/** The real spawn, masked stdio, kernel Clock timers and the kernel's process-group functions (M10R69). */
export function systemPrecheckDeps(clock: Clock, logger?: Logger): PrecheckDeps {
  return {
    spawn,
    stdio: () => maskedStdio(["pipe", "pipe", "pipe"]),
    now: () => clock.now(),
    setTimer(fn, ms) {
      const handle = clock.setTimeout(fn, ms);
      return { cancel: () => clock.clearTimeout(handle) };
    },
    groups: {
      track: trackGroup,
      signal: (pid, signal) => void signalGroup(pid, signal, logger),
      release: releaseGroup,
    },
  };
}

export interface PrecheckPortDeps {
  readonly logger: Logger;
  /** The daemon's environment: the child gets `precheckEnv` of it, never more. */
  readonly env: EnvSource;
  readonly runner: PrecheckDeps;
  /** Scopes on: the shell runs in `scopes.next({ kind: "terminal" })` (agreement 9), reaped after the exit. */
  readonly scopes?: Pick<WorkerScopes, "next">;
  readonly queue?: PrecheckQueue;
  readonly timeoutMs?: number;
  /** One `precheck` span per run (Task 13); only closed values are given to it. */
  readonly span?: () => Span;
}

const BUSY = "precheck busy";
const ABORTED = "precheck aborted";

function detailOf(outcome: Extract<PrecheckOutcome, { verdict: "error" }>): string {
  return outcome.code === "exit" ? `precheck exit ${outcome.exitCode ?? "?"}` : `precheck ${outcome.code}`;
}

/** `PrecheckPort` over `runPrecheck`: the slots (M10R71), the environment, the scope, the log and the span. */
export function createPrecheckPort(deps: PrecheckPortDeps): PrecheckPort & { stop(): void } {
  const queue = deps.queue ?? createPrecheckQueue();
  const running = new Set<AbortController>();
  let stopped = false;

  const failed = (detail: string): PrecheckRun => ({
    verdict: "error",
    exitCode: null,
    durationMs: 0,
    output: "",
    detail,
  });

  return {
    async run(input: PrecheckInput): Promise<PrecheckRun> {
      if (stopped) return failed(ABORTED);
      const controller = new AbortController();
      running.add(controller);
      const relay = (): void => controller.abort();
      if (input.signal?.aborted) controller.abort();
      else input.signal?.addEventListener("abort", relay, { once: true });
      const slot = await queue.acquire(input.triggerId, input.origin, controller.signal);
      if (!slot.ok) {
        input.signal?.removeEventListener("abort", relay);
        running.delete(controller);
        return failed(slot.reason === "busy" ? BUSY : ABORTED);
      }
      const span = deps.span?.();
      const scope = deps.scopes?.next({ kind: "terminal" }) ?? null;
      try {
        const spec = precheckSpec(input.command, precheckEnv(deps.env, input.env), scope?.launch ?? null);
        const outcome = await runPrecheck(spec, input.cwd, deps.runner, {
          timeoutMs: deps.timeoutMs,
          signal: controller.signal,
        });
        const klass = outcome.verdict === "error" ? outcome.code : undefined;
        const exitCode = outcome.verdict === "error" ? outcome.exitCode : outcome.verdict === "fire" ? 0 : 1;
        deps.logger.info("precheck_run", {
          triggerId: input.triggerId,
          verdict: outcome.verdict,
          code: klass === "exit" || klass === undefined ? exitCode : klass,
          durationMs: outcome.durationMs,
        });
        span?.end(klass === undefined ? "ok" : "error", {
          verdict: outcome.verdict,
          ...(klass ? { code: klass } : {}),
        });
        const base = { exitCode, durationMs: Math.round(outcome.durationMs) };
        if (outcome.verdict === "error")
          return { verdict: "error", ...base, output: "", detail: detailOf(outcome) };
        return {
          verdict: outcome.verdict === "fire" ? "pass" : "skip",
          ...base,
          output: outcome.output,
          ...(outcome.verdict === "skip" ? { detail: outcome.reason } : {}),
        };
      } finally {
        slot.release();
        input.signal?.removeEventListener("abort", relay);
        running.delete(controller);
        // The unit and what Pi's children left in it go once the shell is done; the reap never throws.
        if (scope) void scope.reap({ signal: null });
      }
    },
    stop() {
      stopped = true;
      for (const controller of running) controller.abort();
    },
  };
}
