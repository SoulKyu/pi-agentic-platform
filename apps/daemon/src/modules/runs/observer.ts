import { CLAUDE_BRIDGE_PROVIDER, type PiEvent, type SessionLoadout } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { labelValue } from "./labels.ts";
import { classifyLimit } from "./limits.ts";
import type { RunBilling, RunErrorClass, RunProgress, RunRow, RunsStore, RunStatus } from "./store.ts";

/** The session's row, as far as a run needs it: its agent and its parent are copied to the run (M11R73). */
export interface RunSession {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId?: string | undefined;
  readonly parentSessionId?: string | undefined;
}

/** What the sessions module calls (M10R84). Neither method ever throws: a failure is logged and the session goes on. */
export interface RunObserver {
  /** A record of the session's worker; only `run_start` and `run_end` matter. The loadout is the worker's last. */
  onRecord(
    session: RunSession,
    kind: string,
    data: unknown,
    loadout: Pick<SessionLoadout, "billing"> | null,
  ): void;
  /** A Pi event as the worker sent it, before the wire's clipping. */
  onEvent(sessionId: string, event: PiEvent): void;
}

export interface RunStartEvent {
  readonly runId: string;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly taskId: string | null;
  readonly origin: string;
}
export interface RunEndEvent extends RunStartEvent {
  readonly status: Exclude<RunStatus, "running">;
  readonly costUsd: number;
  readonly errorClass: RunErrorClass | null;
  readonly limitResetAt: number | null;
}

/** What a run in flight has used and how it last ended a turn; the error text is classified at the end and never stored. */
export interface OpenRunView {
  readonly runId: string;
  readonly ownerId: string;
  readonly taskId: string | null;
  readonly origin: string;
  readonly costUsd: number;
  readonly stopReason: string | null;
  readonly errorMessage: string | null;
}

export interface RunHooks {
  started(event: RunStartEvent): void;
  /**
   * A run closed as `limited`, inside the transaction that closed it (M10R104): what is written here commits with the
   * run or not at all. It must not throw; the observer catches it so the run stays closed.
   */
  limited(event: RunEndEvent, row: RunRow): void;
  /** After the row is closed and the run is no longer open. */
  ended(event: RunEndEvent, row: RunRow): void;
  live(sessionId: string, ownerId: string, runCostUsd: number): void;
}

const EXPECTATION_TTL_MS = 5 * 60_000;
const MAX_EXPECTATIONS = 64;
const MAX_ERROR_CHARS = 2048;
const LOG_EVERY_MS = 60_000;

interface Expectation {
  readonly origin: string;
  readonly taskId: string | null;
  readonly at: number;
}

interface OpenRun {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string | null;
  readonly origin: string;
  readonly startedAt: number;
  /** The parent of a child's run: its cost rolls up to the parent (M11R141). */
  readonly parentSessionId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  stopReason: string | null;
  errorMessage: string | null;
  ending: RunErrorClass | null;
}

export interface RunTracker extends RunObserver {
  expectOrigin(sessionId: string, expectation: { origin: string; taskId: string | null }): boolean;
  clearExpected(sessionId: string): void;
  markEnding(sessionId: string, errorClass: "deadline" | "run_budget" | "budget"): void;
  /** The cost so far of the session's open run and of its children's open runs (M11R141); null when none is open. */
  liveCost(sessionId: string): number | null;
  /** The cost so far of the owner's open automatic runs (a task's, or a resume), optionally those of `taskIds`. */
  liveSpent(ownerId: string, taskIds: readonly string[] | null): number;
  /** The cost so far of every open run of the owner, interactive included, but those through the Claude bridge (subscription). */
  liveApiSpent(ownerId: string): number;
  peek(sessionId: string): OpenRunView | null;
  /** Closes a run the daemon found open at boot or whose session is gone, as a crash. */
  closeAsCrash(row: RunRow): RunRow | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** A token count a provider reported: whole and not negative, else nothing. */
const tokens = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const money = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const idLabel = (raw: unknown, scrub: (text: string) => { count: number }): string | null =>
  typeof raw === "string" && raw !== "" ? labelValue(raw, scrub) : null;

export function createRunTracker(deps: {
  readonly store: RunsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly newId: () => string;
  readonly scrub: (text: string) => { count: number };
  readonly hooks: RunHooks;
}): RunTracker {
  const { store, clock, hooks } = deps;
  const logger = deps.logger.child({ component: "runs" });
  const limiter = createRateLimiter(clock, LOG_EVERY_MS);
  const open = new Map<string, OpenRun>();
  const expected = new Map<string, Expectation>();

  // A failure here is a FinOps bug, never a session's: it is said once a minute and the session carries on (M10R84).
  function guarded(action: () => void): void {
    try {
      action();
    } catch (error) {
      const said = limiter.check("runs_observer_failed");
      if (said.allowed)
        logger.warn("runs_observer_failed", {
          err: String((error as { message?: unknown }).message ?? error).slice(0, 200),
          suppressed: said.suppressed,
        });
    }
  }

  const progressOf = (run: OpenRun): RunProgress => ({
    provider: run.provider,
    model: run.model,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    costUsd: run.costUsd,
    turns: run.turns,
    toolCalls: run.toolCalls,
  });

  function takeOrigin(sessionId: string, recorded: unknown): { origin: string; taskId: string | null } {
    const wanted = expected.get(sessionId);
    expected.delete(sessionId);
    if (wanted && clock.now() - wanted.at <= EXPECTATION_TTL_MS) return wanted;
    const origin =
      typeof recorded === "string" && recorded.length >= 1 && recorded.length <= 32 ? recorded : "user";
    return { origin, taskId: null };
  }

  function close(
    sessionId: string,
    run: OpenRun,
    status: Exclude<RunStatus, "running">,
    errorClass: RunErrorClass | null,
    billing: RunBilling,
    limitResetAt: number | null = null,
  ): void {
    open.delete(sessionId);
    // A limited run and its resume are written together (M10R104): the row and the effect commit, or neither does.
    const done = store.transaction(() => {
      const row = store.finish(run.id, {
        ...progressOf(run),
        status,
        endedAt: clock.now(),
        billing,
        errorClass,
        limitResetAt,
      });
      if (!row) return undefined;
      const event: RunEndEvent = {
        runId: row.id,
        sessionId,
        ownerId: row.ownerId,
        taskId: row.taskId,
        origin: row.origin,
        status,
        costUsd: row.costUsd,
        errorClass,
        limitResetAt,
      };
      if (status === "limited") guarded(() => hooks.limited(event, row));
      return { event, row };
    });
    if (done) hooks.ended(done.event, done.row);
  }

  function onRunStart(session: RunSession, recorded: unknown): void {
    const prior = open.get(session.id);
    if (prior) close(session.id, prior, "interrupted", "crash", "unknown");
    const { origin, taskId } = takeOrigin(session.id, isRecord(recorded) ? recorded.origin : undefined);
    const id = deps.newId();
    const startedAt = clock.now();
    const { agentId = null, parentSessionId = null } = session;
    store.insertRunning({
      id,
      ownerId: session.ownerId,
      sessionId: session.id,
      taskId,
      origin,
      startedAt,
      agentId,
      parentSessionId,
    });
    open.set(session.id, {
      id,
      ownerId: session.ownerId,
      taskId,
      origin,
      startedAt,
      parentSessionId,
      provider: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      turns: 0,
      toolCalls: 0,
      stopReason: null,
      errorMessage: null,
      ending: null,
    });
    hooks.started({ runId: id, sessionId: session.id, ownerId: session.ownerId, taskId, origin });
  }

  function onRunEnd(
    sessionId: string,
    run: OpenRun,
    data: unknown,
    loadout: Pick<SessionLoadout, "billing"> | null,
  ): void {
    const ended = isRecord(data) ? data : {};
    const billing = loadout?.billing ?? "unknown";
    if ("interrupted" in ended) close(sessionId, run, "interrupted", "crash", billing);
    else if (ended.aborted === true) close(sessionId, run, "cancelled", run.ending ?? "aborted", billing);
    else if (run.stopReason === "error") {
      const verdict = classifyLimit(run.stopReason, run.errorMessage, clock.now());
      if (verdict.kind === "limited")
        close(sessionId, run, "limited", "usage_limit", billing, verdict.resetAt);
      else close(sessionId, run, "failed", "provider", billing);
    } else close(sessionId, run, "completed", null, billing);
  }

  function addUsage(sessionId: string, run: OpenRun, usage: unknown): void {
    if (!isRecord(usage)) return;
    run.inputTokens += tokens(usage.input);
    run.outputTokens += tokens(usage.output);
    run.cacheReadTokens += tokens(usage.cacheRead);
    run.cacheWriteTokens += tokens(usage.cacheWrite);
    run.costUsd += money(isRecord(usage.cost) ? usage.cost.total : undefined);
    // Saved first: the budget the live hook checks reads the row (M11R74).
    store.saveProgress(run.id, progressOf(run));
    hooks.live(sessionId, run.ownerId, run.costUsd);
  }

  const clipError = (text: unknown): string | null =>
    typeof text === "string" ? text.slice(0, MAX_ERROR_CHARS) : null;

  function onEvent(sessionId: string, run: OpenRun, event: PiEvent): void {
    switch (event.type) {
      case "message_end": {
        const message = event.message;
        if (!isRecord(message) || message.role !== "assistant") return;
        run.turns += 1;
        run.provider = idLabel(message.provider, deps.scrub) ?? run.provider;
        run.model = idLabel(message.model, deps.scrub) ?? run.model;
        run.stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
        run.errorMessage = clipError(message.errorMessage);
        addUsage(sessionId, run, message.usage);
        return;
      }
      case "compaction_end": {
        const result = event.result;
        if (typeof event.errorMessage === "string") run.errorMessage = clipError(event.errorMessage);
        if (isRecord(result)) addUsage(sessionId, run, result.usage);
        return;
      }
      case "tool_execution_start":
        if (typeof event.parentToolCallId !== "string") run.toolCalls += 1;
        return;
      default:
        return;
    }
  }

  return {
    onRecord(session, kind, data, loadout) {
      if (kind !== "run_start" && kind !== "run_end") return;
      guarded(() => {
        if (kind === "run_start") return onRunStart(session, data);
        const run = open.get(session.id);
        if (run) onRunEnd(session.id, run, data, loadout);
      });
    },
    onEvent(sessionId, event) {
      const run = open.get(sessionId);
      if (run) guarded(() => onEvent(sessionId, run, event));
    },
    expectOrigin(sessionId, expectation) {
      const now = clock.now();
      for (const [key, held] of expected) if (now - held.at > EXPECTATION_TTL_MS) expected.delete(key);
      if (expectation.origin.length < 1 || expectation.origin.length > 32) return false;
      if (!expected.has(sessionId) && expected.size >= MAX_EXPECTATIONS) return false;
      expected.set(sessionId, { origin: expectation.origin, taskId: expectation.taskId, at: now });
      return true;
    },
    clearExpected: (sessionId) => void expected.delete(sessionId),
    markEnding(sessionId, errorClass) {
      const run = open.get(sessionId);
      if (run) run.ending = errorClass;
    },
    liveCost(sessionId) {
      let total: number | null = null;
      for (const [key, run] of open)
        if (key === sessionId || run.parentSessionId === sessionId) total = (total ?? 0) + run.costUsd;
      return total;
    },
    liveSpent(ownerId, taskIds) {
      let total = 0;
      for (const run of open.values()) {
        const automatic = run.taskId !== null || run.origin === "resume";
        const wanted = taskIds === null || (run.taskId !== null && taskIds.includes(run.taskId));
        if (run.ownerId === ownerId && automatic && wanted) total += run.costUsd;
      }
      return total;
    },
    liveApiSpent(ownerId) {
      let total = 0;
      for (const run of open.values())
        if (run.ownerId === ownerId && run.provider !== CLAUDE_BRIDGE_PROVIDER) total += run.costUsd;
      return total;
    },
    peek(sessionId) {
      const run = open.get(sessionId);
      return run
        ? {
            runId: run.id,
            ownerId: run.ownerId,
            taskId: run.taskId,
            origin: run.origin,
            costUsd: run.costUsd,
            stopReason: run.stopReason,
            errorMessage: run.errorMessage,
          }
        : null;
    },
    closeAsCrash(row) {
      return store.finish(row.id, {
        provider: row.provider,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        costUsd: row.costUsd,
        turns: row.turns,
        toolCalls: row.toolCalls,
        status: "interrupted",
        endedAt: clock.now(),
        billing: row.billing,
        errorClass: "crash",
        limitResetAt: null,
      });
    },
  };
}
