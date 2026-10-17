import { PapError, type TaskState } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { EffectContext, Outbox, Settlement } from "../../kernel/outbox/index.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { RunEndEvent, RunsPort, RunStartEvent } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { createAbortNext } from "./abort-next.ts";
import type { Admission } from "./admit.ts";
import type { AutomationEvents } from "./events.ts";
import type { Fire } from "./fire.ts";
import type { Gates } from "./gates.ts";
import type { RunLimits, StopReason } from "./limits.ts";
import type { AgentStart } from "./runner-agent.ts";
import type { Launch } from "./runner-launch.ts";
import type { ThreadStart } from "./runner-thread.ts";
import type { TaskViews } from "./task-view.ts";
import { createRetry } from "./retry.ts";
import { isTerminal, type Move, parsePolicy, type TaskRow, type TaskStore } from "./tasks.ts";
import type { TriggerRecord } from "./triggers.ts";

const SLOTS_FULL_MS = 10_000;
const CAPACITY_MS = 30_000;
/** After a run ends its worker may still be winding down: the release is tried again a few times. */
const RELEASE_RETRY_MS = 2_000;
const RELEASE_TRIES = 3;
/** The classes of a run the runner itself cut short: the task already moved (Task 5b), a person did not press Stop. */
const RUNNER_ABORTS: ReadonlySet<string> = new Set(["deadline", "run_budget", "budget"]);

export interface RunnerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: TaskStore;
  readonly events: AutomationEvents;
  readonly views: TaskViews;
  readonly fire: Fire;
  /** The daily budget, read again when a queued gated task starts (M10R66). */
  readonly gates: Pick<Gates, "over">;
  readonly admission: { pick(): Admission };
  /** The tasks put off after a `capacity` answer, until a time. */
  readonly putOff: Map<string, number>;
  /** The tasks being started, by owner: a slot each, and never picked twice. */
  readonly starting: Map<string, string>;
  readonly triggers: {
    get(ownerId: string, id: string): TriggerRecord | null;
    resolveFolder(cwd: string): string;
  };
  readonly marks: { started(ownerId: string, triggerId: string, at: number): void };
  readonly sessions: Pick<
    SessionsAutomationPort,
    "createTaskSession" | "prompt" | "abort" | "releaseIdle" | "archive" | "onAttention" | "state"
  >;
  readonly runs: Pick<
    RunsPort,
    "onRunStart" | "onRunEnd" | "expectOrigin" | "clearExpected" | "markEnding" | "onResumeSkipped"
  >;
  readonly limits: Pick<RunLimits, "started" | "ended" | "attention">;
  readonly policy: Pick<PolicyPort, "endTaskPolicy">;
  readonly outbox: Pick<Outbox, "cancel" | "view">;
  /** The outbox receipts of a task's pending resumes (Task 17); none until then. */
  readonly resumeKeys: (task: TaskRow) => readonly string[];
  readonly resumeSending: (sessionId: string) => boolean;
  readonly holdCancel?: boolean;
  /** The agent half (M11R67): the start of an isolated agent task, its card at the end. */
  readonly agents: AgentStart;
  /** The thread target (M11R71): a task that prompts the agent's own thread. */
  readonly thread: Pick<ThreadStart, "start" | "runStarted" | "runEnded" | "mayAbort">;
  /** The commit of a start: the mark, the origin and the prompt (shared with the thread target). */
  readonly launch: Launch;
}

const done: Settlement = { outcome: "done" };

/** The reason stored for a failure: a code of ours, never text from outside. */
const reasonOf = (error: unknown): string => (error instanceof PapError ? error.code : "start_failed");

export function createRunner(deps: RunnerDeps) {
  const { db, clock, logger, store, starting } = deps;
  const timers = new Set<TimerHandle>();
  let stopped = false;
  const heldCancels = new Set<() => void>();
  const abortNext = createAbortNext({ ...deps, sending: deps.resumeSending });

  /** Tells the board and the end hook; the move is committed already, so a failing view never undoes or hides it. */
  function announce(id: string, previous: TaskState): void {
    try {
      const row = store.get(id);
      if (row) deps.events.emit({ kind: "task", ownerId: row.owner_id, task: deps.views(row), previous });
    } catch (error) {
      logger.warn("task_event_failed", { err: error });
    }
  }

  /** The worker of a finished task goes at once when it is idle (owner m10a6, RT-09); a busy one is tried again shortly. */
  function releaseLater(ownerId: string, sessionId: string, tries = RELEASE_TRIES): void {
    try {
      const outcome = deps.sessions.releaseIdle(ownerId, sessionId);
      if (outcome !== "busy" || tries <= 1 || stopped) return;
      const handle = clock.setTimeout(() => {
        timers.delete(handle);
        releaseLater(ownerId, sessionId, tries - 1);
      }, RELEASE_RETRY_MS);
      timers.add(handle);
    } catch (error) {
      logger.warn("task_release_failed", { sessionId, err: error });
    }
  }

  /** One step of the end hook: a failing step is said and never stops the next one. */
  function attempt(sessionId: string, step: () => void): void {
    try {
      step();
    } catch (error) {
      logger.warn("task_end_step_failed", { sessionId, err: error });
    }
  }

  /**
   * The task's end (M10R154), for every terminal move, the boot's included: it is attended again, the origin the runs
   * module waited for is forgotten, a task that finished is archived (owner m10q10) and its idle worker goes at once.
   */
  function endHook(row: TaskRow, sessionId: string | null, state: TaskState, release = true): void {
    deps.limits.ended(row.id);
    if (sessionId === null) {
      // A delegation that never got a session still owes its requester an answer (M11R79).
      attempt(row.id, () => deps.agents.ended(row, state));
      return;
    }
    // An agent's thread outlives the task that prompted it: its policy and its archive mark stay the thread's own (M11R71).
    const own = row.target !== "thread";
    if (own) attempt(sessionId, () => deps.policy.endTaskPolicy(row.owner_id, sessionId));
    attempt(sessionId, () => deps.runs.clearExpected(sessionId));
    if (state === "done" && own) attempt(sessionId, () => deps.sessions.archive(row.owner_id, sessionId));
    attempt(sessionId, () => deps.agents.ended(row, state));
    if (release) releaseLater(row.owner_id, sessionId);
  }

  /**
   * One state change (M10R35). Announces it and, for a terminal one, runs the end hook. `hold` leaves the hook to the
   * caller, who has a run to abort first.
   */
  function settle(
    row: TaskRow,
    from: readonly TaskState[],
    to: TaskState,
    change: Move = {},
    options: { hold?: boolean } = {},
  ): boolean {
    const terminal = isTerminal(to);
    const moved = store.move(row.id, from, to, terminal ? { ...change, endedAt: clock.now() } : change);
    if (!moved) return false;
    // A task waiting for a quota or over has no deadline and no question timer.
    if (terminal || to === "limited") deps.limits.ended(row.id);
    announce(row.id, row.state);
    if (terminal && options.hold !== true) endHook(row, change.sessionId ?? row.session_id, to);
    return true;
  }

  /** M10R39: cuts a run short. The task fails first so that the run's late end is ignored, then the session is aborted. */
  async function stopRun(row: TaskRow, reason: StopReason): Promise<void> {
    const sessionId = row.session_id;
    if (sessionId === null) return;
    // An owner's open run in the thread is never tagged: only a run the task may abort is marked (N2).
    if (deps.thread.mayAbort(row)) deps.runs.markEnding(sessionId, reason);
    if (!settle(row, ["running"], "failed", { reason }, { hold: true })) return;
    try {
      if (deps.thread.mayAbort(row)) await deps.sessions.abort(row.owner_id, sessionId);
    } catch (error) {
      logger.warn("task_abort_failed", { taskId: row.id, err: error });
    }
    endHook(row, sessionId, "failed");
  }

  /** A session made for a task that will not use it: archived, its policy ended, its worker released. */
  function discard(row: TaskRow, sessionId: string): void {
    try {
      deps.policy.endTaskPolicy(row.owner_id, sessionId);
      deps.sessions.archive(row.owner_id, sessionId);
    } catch (error) {
      logger.warn("task_session_discard_failed", { sessionId, err: error });
    }
    releaseLater(row.owner_id, sessionId, 1);
  }

  async function start(row: TaskRow, signal: AbortSignal): Promise<Settlement> {
    const policy = parsePolicy(row.policy);
    if (policy === null) {
      settle(row, ["queued"], "failed", { reason: "bad_policy" });
      return done;
    }
    try {
      // An agent's home is inside pap's own folder, which a project task may never use: the agent gate opens it instead.
      if (row.agent_id === null) deps.triggers.resolveFolder(row.cwd);
    } catch (error) {
      settle(row, ["queued"], "failed", { reason: reasonOf(error) });
      return done;
    }
    // A task admitted before the budget was spent starts after: it fails here, with no session (M10R66).
    if (row.gated === 1 && deps.gates.over(row.owner_id, row.trigger_id, row.agent_id)) {
      settle(row, ["queued"], "failed", { reason: "budget" });
      return done;
    }
    // The task of an agent's thread prompts the thread it has: its own gate, card and prompt (M11R71).
    if (row.target === "thread") return deps.thread.start(row, signal);
    if (signal.aborted) return { outcome: "retry", code: "deadline" };

    let sessionId: string;
    try {
      ({ sessionId } =
        row.agent_id !== null
          ? await deps.agents.begin(row, policy)
          : await deps.sessions.createTaskSession({
              ownerId: row.owner_id,
              cwd: row.cwd,
              policy: {
                mode: policy.mode,
                tools: policy.tools,
                preset: policy.preset,
                tainted: row.tainted === 1,
              },
            }));
    } catch (error) {
      if (error instanceof PapError && error.code === "agent_paused")
        return deps.agents.holdBack(row, settle);
      if (error instanceof PapError && error.code === "capacity") {
        deps.putOff.set(row.id, clock.now() + CAPACITY_MS);
        return { outcome: "defer", until: clock.now() + CAPACITY_MS };
      }
      settle(row, ["queued"], "failed", { reason: reasonOf(error) });
      return done;
    }
    if (signal.aborted) {
      discard(row, sessionId);
      return { outcome: "retry", code: "deadline" };
    }
    // A pause that landed while the session was being made is seen here: the session goes, the task waits (M11R75).
    if (row.agent_id !== null && deps.agents.pausedNow(row)) {
      discard(row, sessionId);
      return deps.agents.holdBack(row, settle);
    }

    // Cancelled between the admission and the mark: the session nobody wants goes, and the effect is spent.
    return deps.launch(row, sessionId, { text: row.prompt, cancelled: () => discard(row, sessionId) });
  }

  /** The `task.start` handler: starts the next task the admission picks, or says when to look again (M10R36). */
  async function handleStart(_payload: { taskId: string }, context: EffectContext): Promise<Settlement> {
    const picked = deps.admission.pick();
    if (picked.kind === "none") {
      if (picked.reason === "empty") return done;
      return {
        outcome: "defer",
        until: clock.now() + (picked.reason === "slots" ? SLOTS_FULL_MS : CAPACITY_MS),
      };
    }
    starting.set(picked.task.id, picked.task.owner_id);
    try {
      return await start(picked.task, context.signal);
    } finally {
      starting.delete(picked.task.id);
    }
  }

  async function cancel(ownerId: string, taskId: string): Promise<{ taskId: string }> {
    const row = store.getOwned(ownerId, taskId);
    if (!row) throw new PapError("not_found");
    if (isTerminal(row.state)) throw new PapError("conflict");
    const live = row.state !== "queued";
    // The task and its session's pending resumes together; a crash after the commit leaves no worker (the boot kills them).
    let resending = false;
    const moved = db.transaction(() => {
      const ok = store.move(taskId, ["queued", "running", "limited"], "cancelled", {
        reason: "cancelled",
        endedAt: clock.now(),
      });
      if (ok && live) resending = abortNext.retire(deps.resumeKeys(row));
      return ok;
    });
    if (!moved) throw new PapError("conflict");
    // Tests only: the crash lands between the commit and the abort (M10R79 d); `stop()` lets go.
    if (deps.holdCancel === true) await new Promise<void>((resolve) => heldCancels.add(resolve));
    deps.limits.ended(taskId);
    announce(taskId, row.state);
    // A continuation already sent into a worker that is still reopening: abort cannot reach it, its start can (M10R105).
    if (resending && row.session_id !== null) abortNext.armIfReopening(ownerId, row.session_id);
    if (live && row.session_id !== null) {
      try {
        if (deps.thread.mayAbort(row)) await deps.sessions.abort(ownerId, row.session_id);
      } catch (error) {
        logger.warn("task_abort_failed", { taskId, err: error });
      }
    }
    endHook(row, row.session_id, "cancelled");
    return { taskId };
  }

  /** M10R38: a task is settled by the end of the run in its session. A run ending after the task is over is ignored. */
  function onRunEnd(event: RunEndEvent): void {
    deps.thread.runEnded(event);
    const row = store.bySession(event.sessionId);
    if (!row || row.state !== "running") return;
    // An agent's thread serves many runs: only the run this task prompted settles it (M11R71).
    if (row.target === "thread" && event.taskId !== row.id) return;
    const { status } = event;
    if (status === "cancelled" && event.errorClass !== null && RUNNER_ABORTS.has(event.errorClass)) return;
    if (status === "limited") {
      settle(row, ["running"], "limited");
      return;
    }
    const outcome = {
      completed: ["done", null],
      failed: ["failed", "provider"],
      cancelled: ["cancelled", "stopped"],
      interrupted: ["interrupted", "crash"],
    } as const;
    const [state, reason] = outcome[status];
    settle(row, ["running"], state, { reason });
  }

  function onRunStart(event: RunStartEvent): void {
    abortNext.runStarted(event.sessionId);
    deps.thread.runStarted(event);
    const row = store.bySession(event.sessionId);
    if (!row || row.state !== "limited") return;
    // Another run of the agent's thread (the owner's message) is not this task's resume (M11R71).
    if (row.target === "thread" && event.taskId !== row.id) return;
    // The deadline starts again with the run (M10R39).
    if (settle(row, ["limited"], "running")) deps.limits.started({ ...row, state: "running" });
  }

  /** M10R160: a limited task whose resume the runs module did not start has no way on. */
  function onResumeSkipped(sessionId: string, reason: string): void {
    abortNext.disarm(sessionId);
    const row = store.bySession(sessionId);
    if (!row || row.state !== "limited") return;
    if (reason === "budget") settle(row, ["limited"], "failed", { reason: "budget" });
    else if (reason === "archived") settle(row, ["limited"], "cancelled", { reason: "archived" });
    // The thread has moved on without this task's resume: it ends, so the agent's next thread task can start.
    else if (row.target === "thread") settle(row, ["limited"], "failed", { reason });
  }

  function onAttention(sessionId: string, needsInput: boolean): void {
    const row = store.bySession(sessionId);
    if (!row || row.state !== "running") return;
    deps.limits.attention(row.id, needsInput);
    deps.events.emit({ kind: "attention", taskId: row.id, sessionId, needsInput });
  }

  const listening: Array<() => void> = [];
  return {
    handleStart,
    cancel,
    retry: createRetry({ store, triggers: deps.triggers, fire: deps.fire }),
    /** Starts hearing the runs (not in read-only mode, where none are recorded). */
    listen(): void {
      listening.push(
        deps.runs.onRunEnd(onRunEnd),
        deps.runs.onRunStart(onRunStart),
        deps.runs.onResumeSkipped(onResumeSkipped),
        deps.sessions.onAttention(onAttention),
      );
    },
    /** Boot-time moves go through the same settle: the event, and the end hook. */
    settle,
    /** Tells the board a task changed without a move (its tool list was lifted). */
    announce,
    /** The end hook alone, for a task that is over already (the boot's sweep of the sessions still unattended). */
    endHook,
    stopRun,
    stop(): void {
      stopped = true;
      for (const release of heldCancels) release();
      for (const stopListening of listening.splice(0)) stopListening();
      for (const handle of timers) clock.clearTimeout(handle);
      timers.clear();
      abortNext.stop();
    },
  };
}
export type Runner = ReturnType<typeof createRunner>;
