import { PapError, type TaskState } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Settlement } from "../../kernel/outbox/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import { DELEGATION_ASK_CHARS, SUMMARY_CHARS } from "../agents/index.ts";
import { writeJournal } from "./fire-journal.ts";
import { createKeptBusy } from "./kept-busy.ts";
import { holdsFiles, type KeptForgetter, keepKeyOfTask, keptTaskEnded } from "./kept-folder.ts";
import type { TaskViews } from "./task-view.ts";
import type { AgentBinding, AgentPorts } from "./trigger-agent.ts";
import type { PutOff } from "./put-off.ts";
import type { Move, TaskPolicySnapshot, TaskRow, TaskStore } from "./tasks.ts";

/** A delegation whose requester is quarantined: it never starts (W5-R64 I4). */
export function requesterQuarantined(ports: AgentPorts, row: TaskRow): boolean {
  if (row.origin !== "delegate" || row.requested_by === null) return false;
  return ports.registry.get(row.owner_id, row.requested_by)?.quarantinedAt != null;
}

/** A task of a paused agent is looked at again after this: not an attempt, and the other tasks go first (M11R67). */
export const PAUSED_MS = 30_000;

type Settle = (row: TaskRow, from: readonly TaskState[], to: TaskState, change?: Move) => boolean;

export interface AgentStartDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly binding: AgentBinding;
  readonly store: Pick<TaskStore, "get">;
  readonly views: TaskViews;
  readonly policy: Pick<PolicyPort, "sessionPolicy">;
  /** The tasks put off until a time: admission skips them meanwhile. */
  readonly putOff: Map<string, PutOff>;
  /** The thread target's half of the end hook: its card moves to the state the task ended with (M11R71). */
  readonly thread?: { ended(row: TaskRow, state: TaskState): void };
  readonly kept: Pick<KeptForgetter, "ended">;
}

/** Ends kept for the bind (a bound on the memory). */
const UNBOUND_MAX = 500;

/** What a scratch removal tells the log: a tree too deep to unlock, or an open that failed for a reason of the host. */
const scratchIssue =
  (logger: Logger, taskId: string) =>
  ({ code }: { readonly code: string }): void =>
    code === "too_deep"
      ? logger.warn("agent_scratch_too_deep", { taskId })
      : logger.warn("agent_scratch_open_failed", { taskId, code });

/**
 * The agent half of the runner (M11R67): an isolated task starts through `createAgentSession` with the `isolated-task`
 * profile, the closed list, and its scratch folder as the one place it writes; the agent's home is read-only.
 */
export function createAgentStart(deps: AgentStartDeps) {
  const { binding, clock, logger } = deps;
  /** Ends heard while the ports were unbound: the boot's recovery runs before the agents module binds. */
  const unbound: Array<{ row: TaskRow; state: "done" | "failed" | "interrupted" }> = [];

  /** M11R67: the journal line of a trigger's task whose sandbox is not there; the task fails with the same word. */
  function journalSandbox(row: TaskRow): void {
    if (row.trigger_id === null) return;
    try {
      deps.db.transaction(() =>
        writeJournal(deps.db, {
          triggerId: row.trigger_id as string,
          ownerId: row.owner_id,
          source: row.origin,
          verdict: "error",
          detail: "sandbox_unavailable",
          taskId: row.id,
          dedupKey: null,
          at: clock.now(),
        }),
      );
    } catch (error) {
      logger.warn("task_journal_failed", { err: error });
    }
  }

  function dropFresh(ports: AgentPorts, row: TaskRow): void {
    try {
      ports.registry.removeScratch(
        row.owner_id,
        row.agent_id as string,
        row.id,
        scratchIssue(logger, row.id),
      );
    } catch (error) {
      logger.warn("agent_scratch_remove_failed", { err: error });
    }
  }

  /**
   * The session of an isolated task. Throws what the start throws: `not_found` (the agent is gone), `agent_paused`
   * (paused or quarantined: `holdBack` tells them apart), `sandbox_unavailable`, `capacity` and the gate's other codes.
   * Nothing awaits before the pause is read: the runner's admission and a delete of the agent meet in one tick (M11R183).
   */
  async function begin(row: TaskRow, policy: TaskPolicySnapshot): Promise<{ sessionId: string }> {
    const ports = binding.ports();
    const agentId = row.agent_id;
    if (!ports || agentId === null) throw new PapError("not_found");
    const agent = ports.registry.get(row.owner_id, agentId);
    if (agent === null) throw new PapError("not_found");
    if (agent.paused || agent.quarantinedAt !== null || requesterQuarantined(ports, row))
      throw new PapError("agent_paused");
    // A delegation owes its answer to a requester: one that is gone leaves the task nothing to run for (m4).
    if (
      row.origin === "delegate" &&
      (row.requested_by === null || !ports.registry.get(row.owner_id, row.requested_by))
    )
      throw new PapError("not_found");
    const { path, reused } = ports.registry.openScratch(row.owner_id, agentId, row.id);
    // W5-R30: Retry makes a NEW task with a NEW folder; only an outbox re-run of this same task id reuses this one.
    // A task started again finds the files of its first attempt: unless the folder is empty, the run starts tainted
    // (W5-R9: it would otherwise read, as its own work, what an earlier tainted attempt wrote there).
    const keepKey = keepKeyOfTask(row, policy);
    // A kept folder holds whatever earlier runs read from outside: every run starts tainted (K-R3).
    const tainted = keepKey !== null || row.tainted === 1 || (reused && holdsFiles(path));
    try {
      return await ports.sessions.createAgentSession({
        ownerId: row.owner_id,
        agentId,
        role: "task",
        task: {
          mode: policy.mode,
          tools: policy.tools,
          preset: policy.preset,
          tainted,
          ...(keepKey === null ? {} : { keepKey }),
        },
        scratch: path,
      });
    } catch (error) {
      // The folder this start made goes with the start; one an earlier attempt made stays, as evidence.
      if (!reused) dropFresh(ports, row);
      if (error instanceof PapError && error.code === "sandbox_unavailable") journalSandbox(row);
      throw error;
    }
  }

  /** The agent is paused or quarantined now (read again). */
  function pausedNow(row: TaskRow): boolean {
    const ports = binding.ports();
    const agent = row.agent_id === null ? null : ports?.registry.get(row.owner_id, row.agent_id);
    return (
      (agent !== null && agent !== undefined && (agent.paused || agent.quarantinedAt !== null)) ||
      (ports !== null && ports !== undefined && requesterQuarantined(ports, row))
    );
  }

  /** A start refused with `agent_paused`: a quarantined agent's task is cancelled, a paused one waits (not an attempt). */
  function holdBack(row: TaskRow, settle: Settle): Settlement {
    const agent = row.agent_id === null ? null : binding.ports()?.registry.get(row.owner_id, row.agent_id);
    const ports = binding.ports();
    if ((agent && agent.quarantinedAt !== null) || (ports && requesterQuarantined(ports, row))) {
      settle(row, ["queued"], "cancelled", { reason: "quarantined" });
      return { outcome: "done" };
    }
    const until = clock.now() + PAUSED_MS;
    deps.putOff.set(row.id, { until, reason: "paused" });
    return { outcome: "defer", until };
  }

  /**
   * What a task's run ended with, for the cards it leaves: the run's last words (cut to what the largest card takes) and
   * whether it was tainted. A summary that cannot be read is null; a taint that cannot be read is "tainted" (fails closed).
   */
  async function outcome(
    ports: AgentPorts,
    row: TaskRow,
    sessionId: string,
  ): Promise<{ summary: string | null; tainted: boolean }> {
    const summary = await ports.sessions
      .lastText(
        row.owner_id,
        sessionId,
        row.origin === "delegate" ? DELEGATION_ASK_CHARS : SUMMARY_CHARS,
        // A thread holds earlier runs: only an answer given since this task started is its own (m1).
        row.target === "thread" ? (row.started_at ?? undefined) : undefined,
      )
      .catch((error: unknown) => {
        logger.warn("agent_card_summary_failed", { err: error });
        return null;
      });
    let tainted = true;
    try {
      tainted = row.tainted === 1 || deps.policy.sessionPolicy(row.owner_id, sessionId).taint.tainted;
    } catch (error) {
      logger.warn("agent_card_taint_failed", { err: error });
    }
    return { summary, tainted };
  }

  /**
   * M11R79: a delegated task that ended `done` or `failed` tells its requester, as a card and an Inbox item, never as a
   * prompt. Only the delegation itself: a reminder that inherited `requested_by` sends nothing back.
   */
  function delegationBack(
    ports: AgentPorts,
    row: TaskRow,
    state: "done" | "failed" | "interrupted",
    result: { summary: string | null; tainted: boolean },
  ): void {
    if (row.origin !== "delegate" || row.requested_by === null || row.agent_id === null) return;
    ports.delegations.back({
      ownerId: row.owner_id,
      taskId: row.id,
      requesterId: row.requested_by,
      targetId: row.agent_id,
      state,
      isolated: row.target === "isolated",
      ...result,
    });
  }

  /** The card of an isolated run that ended `done` or `failed` (M11R69). Untrusted text never leaves the summary. */
  async function card(ports: AgentPorts, row: TaskRow, state: "done" | "failed"): Promise<void> {
    const { agent_id: agentId, session_id: sessionId } = row;
    if (agentId === null) return;
    if (sessionId === null)
      return delegationBack(ports, row, state, { summary: null, tainted: row.tainted === 1 });
    const ended = deps.store.get(row.id);
    const result = await outcome(ports, row, sessionId);
    const started = ended?.started_at ?? null;
    const over = ended?.ended_at ?? null;
    ports.events.isolated(row.owner_id, agentId, row.id, {
      title: row.title,
      state,
      source: row.origin,
      tainted: result.tainted,
      scratch: ports.registry.scratchPathOf(row.owner_id, agentId, row.id),
      summary: result.summary,
      durationMs: started !== null && over !== null ? over - started : null,
      costUsd: ended ? deps.views(ended).costUsd : 0,
    });
    delegationBack(ports, row, state, result);
  }

  /** A delegation that ran in the target's thread: its result goes back; the thread has no card of its own to move. */
  async function threadResult(ports: AgentPorts, row: TaskRow, state: "done" | "failed"): Promise<void> {
    if (row.origin !== "delegate") return;
    const result =
      row.session_id === null
        ? { summary: null, tainted: row.tainted === 1 }
        : await outcome(ports, row, row.session_id);
    delegationBack(ports, row, state, result);
  }

  function cardsOf(ports: AgentPorts, row: TaskRow, state: "done" | "failed" | "interrupted"): void {
    // A run the boot cut short has no summary and no card of its own, but its requester is still told (T12).
    if (state === "interrupted")
      return delegationBack(ports, row, state, { summary: null, tainted: row.tainted === 1 });
    const work =
      row.target === "isolated"
        ? card(ports, row, state)
        : row.target === "thread"
          ? threadResult(ports, row, state)
          : null;
    work?.catch((error: unknown) => logger.warn("agent_card_failed", { err: error }));
  }

  return {
    begin,
    keptBusy: createKeptBusy({ clock, logger, putOff: deps.putOff }),
    pausedNow,
    holdBack,
    /**
     * The task's end hook: a card for an isolated agent task that ended `done` or `failed`; unbound ends wait for `replay`.
     */
    ended(row: TaskRow, state: TaskState): void {
      const ports = binding.ports();
      if (row.target === "thread") deps.thread?.ended(row, state);
      if (row.agent_id === null) return;
      keptTaskEnded(deps.kept, row);
      if (state !== "done" && state !== "failed" && !(state === "interrupted" && row.origin === "delegate"))
        return;
      if (!ports) {
        if (unbound.length < UNBOUND_MAX) unbound.push({ row, state });
        else logger.warn("agent_card_dropped_unbound", { taskId: row.id });
        return;
      }
      cardsOf(ports, row, state);
    },

    /** The ends heard before the agents were bound: their cards and their answers go out now. */
    replay(): void {
      const ports = binding.ports();
      if (!ports) return;
      for (const { row, state } of unbound.splice(0)) cardsOf(ports, row, state);
    },
  };
}
export type AgentStart = ReturnType<typeof createAgentStart>;

export interface AgentTaskLinkDeps {
  readonly store: Pick<TaskStore, "ofAgent" | "requestedBy" | "get">;
  /** The tasks being started now. */
  readonly starting: () => string[];
  readonly cancel: (ownerId: string, taskId: string) => Promise<unknown>;
}

/** The tasks' half of the agents registry's link (carry 1, M11R183): what a delete waits for and what it cancels. */
export function createAgentTaskLink(deps: AgentTaskLinkDeps) {
  async function cancelStates(
    ownerId: string,
    agentId: string,
    states: readonly TaskState[],
    requested = false,
  ): Promise<number> {
    let cancelled = 0;
    let failure: unknown = null;
    // `requested`: the delegations the agent asked for, running ones included (W5-R65), instead of the agent's own tasks.
    for (const task of requested
      ? deps.store.requestedBy(ownerId, agentId, ["queued", "running", "limited"])
      : deps.store.ofAgent(ownerId, agentId, states)) {
      try {
        await deps.cancel(ownerId, task.id);
        cancelled += 1;
      } catch (error) {
        // Moved by someone else meanwhile (started, cancelled): nothing left to cancel. Any other failure does not
        // stop the next task (a stuck one must not leave the rest running); the first is thrown at the end.
        if (!(error instanceof PapError && (error.code === "conflict" || error.code === "not_found")))
          failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return cancelled;
  }
  return {
    /** A task of the agent runs, waits for a quota, or is being started (between its admission and its first state). */
    busy(ownerId: string, agentId: string): boolean {
      if (deps.store.ofAgent(ownerId, agentId, ["running", "limited"]).length > 0) return true;
      return deps.starting().some((id) => {
        const task = deps.store.get(id);
        return task?.owner_id === ownerId && task.agent_id === agentId;
      });
    },
    /** Cancels the agent's queued tasks (the owner's own Cancel, so each is announced and ends as the board expects). */
    async cancelQueuedOf(ownerId: string, agentId: string): Promise<void> {
      await cancelStates(ownerId, agentId, ["queued"]);
    },
    /** Quarantine (M11R115): the same cancel for the running and quota-waiting tasks too; how many ended. */
    cancelAllOf: async (ownerId: string, agentId: string): Promise<number> =>
      (await cancelStates(ownerId, agentId, ["queued", "running", "limited"])) +
      // Its outgoing requests are the agent's doing too: none may start in another agent's thread afterwards (W5-R64 I4).
      (await cancelStates(ownerId, agentId, ["queued", "running", "limited"], true)),
  };
}

/**
 * M11R180: the housekeeping hook. When the 30-day cleanup deletes an isolated task's session, its scratch folder goes
 * (a link inside is removed, never followed). A folder that will not go is said, and the pass goes on.
 */
export function createAgentScratchDropper(ports: () => AgentPorts | null, logger: Logger) {
  return (task: TaskRow): void => {
    if (task.agent_id === null || task.target !== "isolated") return;
    try {
      const live = ports();
      // A session the row never got (cancelled before its commit, a re-run after the deadline) may still work in it.
      const path = live?.registry.scratchPathOf(task.owner_id, task.agent_id, task.id);
      if (path !== undefined && live?.sessions.taskFolders().has(path)) return;
      live?.registry.removeScratch(task.owner_id, task.agent_id, task.id, scratchIssue(logger, task.id));
    } catch (error) {
      // An agent that was deleted took its folders to the trash with it.
      if (!(error instanceof PapError && error.code === "not_found"))
        logger.warn("agent_scratch_remove_failed", { err: error });
    }
  };
}

/** Folders swept in one housekeeping pass: a backlog drains over the next passes. */
const SWEEP_PER_PASS = 100;

/**
 * M11R180, I3: the sweep. A scratch folder that no task row and no session names is an orphan (its row was cleaned, its
 * session deleted), and goes. A folder a live task or a session works in is kept; links are unlinked, never followed.
 */
export function createAgentScratchSweeper(deps: {
  readonly ports: () => AgentPorts | null;
  readonly hasTask: (taskId: string) => boolean;
  readonly logger: Logger;
}) {
  return (): void => {
    const ports = deps.ports();
    if (!ports) return;
    try {
      const inUse = ports.sessions.taskFolders();
      ports.registry.sweepScratch(
        (_agentId, taskId, path) => deps.hasTask(taskId) || inUse.has(path),
        SWEEP_PER_PASS,
        (info) => deps.logger.warn("agent_scratch_sweep_entry_failed", info),
      );
    } catch (error) {
      deps.logger.warn("agent_scratch_sweep_failed", { err: error });
    }
  };
}
