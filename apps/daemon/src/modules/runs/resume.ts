import { type ApprovalMode, type AutomationSettings, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import {
  enqueueEffect,
  type EffectContext,
  type Outbox,
  type Settlement,
} from "../../kernel/outbox/index.ts";
import type { RunsPort, RunsService } from "./service.ts";
import type { RunRow } from "./store.ts";

/** T3's text for a continuation (`UsageLimitRecoveryWorker`). */
export const RESUME_PROMPT = "Continue where you left off.";
const MAX_JITTER_MS = 60_000;
const CAPACITY_DEFER_MS = 5 * 60_000;
/** An owner's prompt or reopen is on its way: look again soon, the next look sees their run and skips. */
const PENDING_DEFER_MS = 30_000;

/**
 * The receipt of a resume, and the key the outbox cancels it by (M10R104). The task runner's Cancel names the same keys
 * through `Resume.keysOf` once the lanes join.
 * @public
 */
export const resumeKey = (sessionId: string, runId: string, resetAt: number): string =>
  `resume:${sessionId}:${runId}:${resetAt}`;

/** 0 to 59 999 ms taken from the session id (FNV-1a): sessions sharing a reset do not all wake in the same second. */
export function resumeJitter(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % MAX_JITTER_MS;
}

/** What the resume asks of the sessions module: the automation port's three calls, nothing else. */
export interface ResumeSessions {
  state(
    ownerId: string,
    sessionId: string,
  ): { archived: boolean; running: boolean; needsInput: boolean } | null;
  /** A prompt now would not be refused for capacity (a warm session, or a worker left free for the owner). */
  admits(ownerId: string, sessionId: string): boolean;
  /** A prompt or a reopen is in flight whose run has not started. */
  promptPending(ownerId: string, sessionId: string): boolean;
  prompt(input: {
    ownerId: string;
    sessionId: string;
    text: string;
    sandboxedOnly?: boolean;
  }): Promise<"started" | "queued" | "handled">;
}

export interface ResumeDeps {
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
  readonly runs: Pick<RunsService, "lookup" | "resumeSkipped" | "onLimited">;
  readonly port: Pick<RunsPort, "spentToday" | "expectOrigin" | "clearExpected" | "onRunEnd">;
  readonly outbox: Pick<Outbox, "register" | "poke" | "cancel" | "view" | "db">;
  readonly settings: (
    ownerId: string,
  ) => Pick<AutomationSettings, "autoResume" | "dailyBudgetUsd" | "timezone" | "paused">;
  /** The session's effective mode now (its own, else the owner's default). */
  readonly modeOf: (ownerId: string, sessionId: string) => ApprovalMode;
  readonly sessions: ResumeSessions;
  /** Owner a5: an agent thread whose sandbox is on (registry now, and its worker's start): its full-access run may resume. */
  readonly sandboxedAgent?: (ownerId: string, sessionId: string) => boolean;
  /** The session is an agent's (thread or child): a token never continues it (M11R4, W5-R64). */
  readonly agentSession?: (ownerId: string, sessionId: string) => boolean;
  /** The session is a child of a `subagent` call: its call is over at the run end, so nothing continues it on its own (M11R139). */
  readonly childSession?: (ownerId: string, sessionId: string) => boolean;
  /**
   * The task that owns the session (a Resume now click's run carries none, so the chain would lose it) and whether its
   * trigger is over its own daily budget (M10R66): a scheduled resume is skipped then. A click is not asked.
   */
  readonly taskOf?: (ownerId: string, sessionId: string) => { taskId: string; overBudget: boolean } | null;
  /** A limited session's resume state changed without a run (a cancel): the `usage` stream says so. */
  readonly limitChanged: (ownerId: string, sessionId: string) => void;
}

type Skip = "archived" | "newer_input" | "full_access" | "budget" | "child";

export interface Resume {
  /** Writes the `run.resume` effect for a run that just closed as `limited`, in the caller's transaction. */
  plan(row: RunRow): void;
  /** Registers the effect handler, the planner and the wake-up after a limited run. */
  attach(): void;
  /** Sends now. A token's is automation (budget applies, origin `resume`); the browser's click is the owner's own (M10R106). */
  resumeNow(caller: { userId: string; kind: string }, sessionId: string): Promise<void>;
  cancelResume(ownerId: string, sessionId: string): Promise<void>;
  /** The receipts of the session's pending resume: what Cancel of a task cancels. */
  keysOf(sessionId: string): string[];
  /** A continuation is on its way to Pi for the session (from the sent mark until the prompt settles). */
  sending(sessionId: string): boolean;
}

export function createResume(deps: ResumeDeps): Resume {
  const { clock, outbox, sessions, runs } = deps;
  const lookup = runs.lookup;
  // Sessions with a continuation on its way to Pi: a second one (a double click, the handler) never starts.
  const sending = new Set<string>();

  const keyOf = (row: RunRow): string | null =>
    row.limitResetAt === null ? null : resumeKey(row.sessionId, row.id, row.limitResetAt);

  function overBudget(ownerId: string): boolean {
    const { dailyBudgetUsd, timezone } = deps.settings(ownerId);
    return dailyBudgetUsd !== null && deps.port.spentToday(ownerId, timezone) >= dailyBudgetUsd;
  }

  /** M10R104 with owner a5's exception (decision 90): full access holds a continuation unless the agent's sandbox is on. */
  const heldForFullAccess = (ownerId: string, sessionId: string): boolean =>
    deps.modeOf(ownerId, sessionId) === "full-access" && deps.sandboxedAgent?.(ownerId, sessionId) !== true;

  async function send(ownerId: string, row: RunRow, sandboxedOnly = false): Promise<void> {
    const { sessionId } = row;
    sending.add(sessionId);
    try {
      const disposition = await sessions.prompt({
        ownerId,
        sessionId,
        text: RESUME_PROMPT,
        ...(sandboxedOnly ? { sandboxedOnly } : {}),
      });
      // A prompt that starts no run must not leave its origin armed for the owner's next run.
      if (disposition === "handled") {
        deps.port.clearExpected(sessionId);
        // No run will start: a Cancel's one-shot abort must not wait for the owner's next prompt.
        runs.resumeSkipped(sessionId, "handled");
      }
    } catch (error) {
      deps.port.clearExpected(sessionId);
      // No run will start for this continuation: whoever waits for it (a task's Cancel) stops waiting. The sandbox
      // refusal of a sandbox-only send is skipped by the handler as `full_access`, not reported twice.
      if (!(sandboxedOnly && error instanceof PapError && error.code === "sandbox_unavailable"))
        runs.resumeSkipped(sessionId, "send_failed");
      throw error;
    } finally {
      sending.delete(sessionId);
    }
  }

  function plan(row: RunRow): void {
    const resetAt = row.limitResetAt;
    if (resetAt === null || !deps.settings(row.ownerId).autoResume) return;
    if (heldForFullAccess(row.ownerId, row.sessionId)) return;
    if (deps.childSession?.(row.ownerId, row.sessionId) === true) {
      runs.resumeSkipped(row.sessionId, "child");
      return;
    }
    enqueueEffect(
      outbox.db,
      {
        kind: "run.resume",
        ownerId: row.ownerId,
        payload: { sessionId: row.sessionId, runId: row.id, resetAt },
        dedupKey: resumeKey(row.sessionId, row.id, resetAt),
        at: resetAt + resumeJitter(row.sessionId),
      },
      clock.now(),
    );
  }

  /** Everything the handler checks before its point of no return, in the brief's order. Synchronous: nothing can slip in. */
  function refusal(
    ownerId: string,
    row: RunRow,
    state: { archived: boolean; running: boolean },
  ): Skip | null {
    if (state.archived) return "archived";
    if (deps.childSession?.(ownerId, row.sessionId) === true) return "child";
    if (lookup.newerThan(row) || state.running || sending.has(row.sessionId)) return "newer_input";
    if (heldForFullAccess(ownerId, row.sessionId)) return "full_access";
    if (overBudget(ownerId)) return "budget";
    if (deps.taskOf?.(ownerId, row.sessionId)?.overBudget === true) return "budget";
    return null;
  }

  const done: Settlement = { outcome: "done" };

  async function handle(
    payload: { sessionId: string; runId: string },
    context: EffectContext,
  ): Promise<Settlement> {
    const ownerId = context.ownerId;
    if (ownerId === null || context.cancelRequested()) return done;
    const { sessionId } = payload;
    const state = sessions.state(ownerId, sessionId);
    const row = lookup.get(payload.runId);
    if (!state || !row || row.ownerId !== ownerId || row.sessionId !== sessionId || row.status !== "limited")
      return done;
    // Read first: the owner may have switched auto-resume off, or paused automation, since it was scheduled. A paused
    // owner's resume waits, whatever the budget says (a spent budget must not fail the task of a pause).
    const settings = deps.settings(ownerId);
    if (!settings.autoResume) return done;
    if (settings.paused) return { outcome: "defer", until: clock.now() + CAPACITY_DEFER_MS };
    const skip = refusal(ownerId, row, state);
    if (skip !== null) {
      runs.resumeSkipped(sessionId, skip);
      return done;
    }
    // The owner's own prompt is being accepted: it wins, and must not take this resume's origin (I1).
    if (sessions.promptPending(ownerId, sessionId))
      return { outcome: "defer", until: clock.now() + PENDING_DEFER_MS };
    if (!sessions.admits(ownerId, sessionId))
      return { outcome: "defer", until: clock.now() + CAPACITY_DEFER_MS };
    // A full table of expectations would tag the continuation as the owner's own, outside the budget: wait instead.
    if (
      !deps.port.expectOrigin(sessionId, {
        origin: "resume",
        taskId: row.taskId ?? deps.taskOf?.(ownerId, sessionId)?.taskId ?? null,
      })
    )
      return { outcome: "defer", until: clock.now() + CAPACITY_DEFER_MS };
    // From here a crash retires the effect and never replays it (M10R149).
    // Only the test seam returns a promise here; without it nothing yields between the mark and the send.
    // Owner a5: a full-access continuation goes out sandbox-only; only then is `sandbox_unavailable` a held resume.
    const sandboxedOnly = deps.modeOf(ownerId, sessionId) === "full-access";
    const held = context.markSent();
    if (held instanceof Promise) await held;
    try {
      await send(ownerId, row, sandboxedOnly);
      return done;
    } catch (error) {
      const code = error instanceof PapError ? error.code : "prompt_failed";
      // The sandbox is gone since the check (a cold start refused, a warm worker without one): held, like full access.
      if (sandboxedOnly && code === "sandbox_unavailable") {
        runs.resumeSkipped(sessionId, "full_access");
        return done;
      }
      // Pi refused because a run was already going or starting: the owner's input won, and nothing was lost.
      if (code === "session_busy" || code === "prompt_rejected") {
        runs.resumeSkipped(sessionId, "newer_input");
        return done;
      }
      return { outcome: "fail", code };
    }
  }

  async function resumeNow(caller: { userId: string; kind: string }, sessionId: string): Promise<void> {
    const ownerId = caller.userId;
    const state = sessions.state(ownerId, sessionId);
    if (!state) throw new PapError("not_found");
    if (caller.kind === "token" && deps.agentSession?.(ownerId, sessionId) === true)
      throw new PapError("forbidden");
    const row = lookup.latestOf(sessionId);
    if (
      !row ||
      row.ownerId !== ownerId ||
      row.status !== "limited" ||
      state.archived ||
      sending.has(sessionId)
    )
      throw new PapError("conflict");
    if (state.running || sessions.promptPending(ownerId, sessionId)) throw new PapError("session_busy");
    if (caller.kind === "token") {
      if (deps.settings(ownerId).paused) throw new PapError("automation_paused");
      if (overBudget(ownerId)) throw new PapError("budget_reached");
    }
    if (!sessions.admits(ownerId, sessionId)) throw new PapError("capacity");
    // A token's continuation is automation: its run is a `resume` one, counted and abortable by the budget. Only the
    // owner's browser click is the owner's own run (no origin, never counted or aborted).
    const tagged = caller.kind === "token";
    if (
      tagged &&
      !deps.port.expectOrigin(sessionId, {
        origin: "resume",
        taskId: row.taskId ?? deps.taskOf?.(ownerId, sessionId)?.taskId ?? null,
      })
    )
      throw new PapError("capacity");
    const key = keyOf(row);
    if (key !== null) {
      // A scheduled effect must not send a second time: retired if pending, marked if leased (it reads the mark).
      outbox.cancel(key);
      // One that passed its mark and is still settling is sending right now (the sending guard above covers it).
      if (outbox.view(key)?.status === "leased" && outbox.view(key)?.sent === true) {
        if (tagged) deps.port.clearExpected(sessionId);
        throw new PapError("conflict");
      }
    }
    // A scheduled effect that already ended without a run (failed after its mark, retired by a crash, handled) leaves
    // the run limited: the click then sends anew (I3).
    await send(ownerId, row);
  }

  async function cancelResume(ownerId: string, sessionId: string): Promise<void> {
    if (!sessions.state(ownerId, sessionId)) throw new PapError("not_found");
    const row = lookup.latestOf(sessionId);
    const key = row?.status === "limited" && row.ownerId === ownerId ? keyOf(row) : null;
    if (key === null) return;
    outbox.cancel(key);
    deps.limitChanged(ownerId, sessionId);
  }

  return {
    plan,
    attach() {
      runs.onLimited((_event, row) => plan(row));
      deps.port.onRunEnd((event) => {
        if (event.status === "limited") outbox.poke();
      });
      outbox.register("run.resume", handle);
    },
    resumeNow,
    cancelResume,
    sending: (sessionId) => sending.has(sessionId),
    keysOf(sessionId) {
      const row = lookup.latestOf(sessionId);
      const key = row?.status === "limited" ? keyOf(row) : null;
      return key === null ? [] : [key];
    },
  };
}
