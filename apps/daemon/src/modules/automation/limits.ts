import { AUTOMATION_LIMITS } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import type { AutomationEvents } from "./events.ts";
import type { Gates } from "./gates.ts";
import type { TaskRow, TaskStore } from "./tasks.ts";

/** Why the runner cut a run short; also the class `markEnding` tags the run with and the reason the task fails with. */
export type StopReason = "deadline" | "run_budget" | "budget";

export interface RunLimitsDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: Pick<TaskStore, "get" | "runningGated">;
  readonly runs: Pick<RunsPort, "onLiveCost" | "onRunStart" | "onRunEnd" | "markEnding">;
  readonly port: Pick<SessionsAutomationPort, "answerUnattended" | "abort" | "state">;
  readonly gates: Pick<Gates, "ownerOver" | "triggerOver" | "agentOver">;
  readonly events: AutomationEvents;
  /** The runner's: marks the run, fails the task (terminal), aborts the session and ends the task. Resolves when done. */
  stop(task: TaskRow, reason: StopReason): Promise<void>;
}

interface Armed {
  readonly taskId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  /** An agent's thread belongs to its owner: its dialogs wait for them, never for a timer (M11R169, M11R31). */
  readonly thread: boolean;
  readonly maxUsd: number | null;
  deadline: TimerHandle | null;
  question: TimerHandle | null;
}

const QUESTION_MS = AUTOMATION_LIMITS.inputWaitMinutes * 60_000;

/**
 * What bounds an unattended run (M10R39): its time, its money, the owner's day and a question nobody answers. Every
 * timer is on the Clock and runs through `guardTimer`; the boot interrupts every running task, so none is persisted.
 */
export function createRunLimits(deps: RunLimitsDeps) {
  const { clock, logger, store, runs, port } = deps;
  const armed = new Map<string, Armed>();
  const bySession = new Map<string, string>();
  /** Open automatic resume runs of interactive sessions (no task): the budget aborts them too. */
  const resumes = new Map<string, string>();
  /** Sessions whose open run is the owner's own (a Resume now click, M10R106): the daily budget leaves their task alone. */
  const ownerRuns = new Set<string>();
  const listening: Array<() => void> = [];

  const guarded = (name: string, work: () => void | Promise<void>): void =>
    void guardTimer(logger, name, work, clock);

  function clearTimers(entry: Armed): void {
    if (entry.deadline) clock.clearTimeout(entry.deadline);
    if (entry.question) clock.clearTimeout(entry.question);
    entry.deadline = null;
    entry.question = null;
  }

  function ended(taskId: string): void {
    const entry = armed.get(taskId);
    if (!entry) return;
    clearTimers(entry);
    armed.delete(taskId);
    bySession.delete(entry.sessionId);
  }

  /** The task is still running: a stale timer or event never stops a task that is over, limited or cancelled. */
  function runningTask(taskId: string): TaskRow | null {
    const row = store.get(taskId);
    return row && row.state === "running" && row.session_id !== null ? row : null;
  }

  function armQuestion(entry: Armed): void {
    if (entry.question) return;
    entry.question = clock.setTimeout(() => {
      entry.question = null;
      guarded("task_question_timeout", () => {
        if (armed.get(entry.taskId) !== entry) return;
        const row = runningTask(entry.taskId);
        if (!row || row.session_id === null) return;
        const denied = port.answerUnattended(row.owner_id, row.session_id);
        deps.events.emit({ kind: "attention_timeout", taskId: row.id, denied });
        // A new question that came in at once does not flip the flag again: wait for it too, until the deadline.
        if (port.state(row.owner_id, row.session_id)?.needsInput) armQuestion(entry);
      });
    }, QUESTION_MS);
  }

  /** A run in the owner's name aborted without a task of its own to move (an automatic resume). */
  function abortResume(ownerId: string, sessionId: string): Promise<void> {
    runs.markEnding(sessionId, "budget");
    return port.abort(ownerId, sessionId);
  }

  function live(sessionId: string, ownerId: string, runCostUsd: number): void {
    const entry = bySession.has(sessionId) ? armed.get(bySession.get(sessionId) as string) : undefined;
    if (entry && entry.maxUsd !== null && runCostUsd >= entry.maxUsd) {
      const row = runningTask(entry.taskId);
      if (row) guarded("task_cost_cap", () => deps.stop(row, "run_budget"));
    }
    // The owner's line stops every gated task and the automatic resumes; a trigger's own line stops its own tasks (M10R66).
    // A browser's manual fire (gated = 0) and the owner's own interactive runs are not here; a "Resume now" click is not stopped.
    // An agent's own line stops the agent's gated tasks, its thread tasks too (M11R74); the owner's runs are not tasks.
    const ownerOver = deps.gates.ownerOver(ownerId);
    const triggerOver = new Map<string, boolean>();
    const agentOver = new Map<string, boolean>();
    for (const row of store.runningGated(ownerId)) {
      if (row.session_id !== null && ownerRuns.has(row.session_id)) continue;
      const own = row.trigger_id;
      if (!ownerOver && own !== null && !triggerOver.has(own))
        triggerOver.set(own, deps.gates.triggerOver(ownerId, own));
      const agent = row.agent_id;
      if (!ownerOver && agent !== null && !agentOver.has(agent))
        agentOver.set(agent, deps.gates.agentOver(ownerId, agent));
      if (
        ownerOver ||
        (own !== null && triggerOver.get(own) === true) ||
        (agent !== null && agentOver.get(agent) === true)
      )
        guarded("task_budget_abort", () => deps.stop(row, "budget"));
    }
    if (!ownerOver) return;
    for (const [resumeSession, resumeOwner] of resumes)
      if (resumeOwner === ownerId) guarded("resume_budget_abort", () => abortResume(ownerId, resumeSession));
  }

  return {
    /** The task is running (again): its deadline starts from now, its cost cap from the run's own cost. */
    started(task: TaskRow): void {
      ended(task.id);
      if (task.session_id === null) return;
      const entry: Armed = {
        taskId: task.id,
        ownerId: task.owner_id,
        sessionId: task.session_id,
        thread: task.target === "thread",
        maxUsd: task.max_run_usd,
        deadline: null,
        question: null,
      };
      armed.set(task.id, entry);
      bySession.set(task.session_id, task.id);
      entry.deadline = clock.setTimeout(() => {
        entry.deadline = null;
        guarded("task_deadline", async () => {
          if (armed.get(entry.taskId) !== entry) return;
          const row = runningTask(entry.taskId);
          if (row) await deps.stop(row, "deadline");
        });
      }, task.max_run_ms);
    },
    /** The task is over or waiting for a quota: no deadline, no question timer. */
    ended,
    /** The session of a running task started or stopped waiting for an answer. */
    attention(taskId: string, needsInput: boolean): void {
      const entry = armed.get(taskId);
      if (!entry || entry.thread) return;
      if (!needsInput) {
        if (entry.question) clock.clearTimeout(entry.question);
        entry.question = null;
        return;
      }
      armQuestion(entry);
    },
    /** Hears the cost of every run and the automatic resume runs (not in read-only mode, where none is recorded). */
    listen(): void {
      listening.push(
        runs.onLiveCost((sessionId, ownerId, cost) =>
          guarded("run_limits", () => live(sessionId, ownerId, cost)),
        ),
        runs.onRunStart((event) => {
          if (event.taskId === null && event.origin === "resume") resumes.set(event.sessionId, event.ownerId);
          if (event.taskId === null && event.origin === "user") ownerRuns.add(event.sessionId);
        }),
        runs.onRunEnd((event) => {
          resumes.delete(event.sessionId);
          ownerRuns.delete(event.sessionId);
        }),
      );
    },
    stop(): void {
      for (const stopListening of listening.splice(0)) stopListening();
      for (const entry of armed.values()) clearTimers(entry);
      armed.clear();
      bySession.clear();
      resumes.clear();
      ownerRuns.clear();
    },
  };
}
export type RunLimits = ReturnType<typeof createRunLimits>;
