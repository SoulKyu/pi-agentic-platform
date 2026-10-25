import { PAP_TEXT, PapError, type TaskState } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Settlement } from "../../kernel/outbox/index.ts";
import type { RunStartEvent } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { PAUSED_MS, requesterQuarantined } from "./runner-agent.ts";
import type { Launch } from "./runner-launch.ts";
import { capacityWait, type PutOff } from "./put-off.ts";
import type { Move, TaskRow, TaskStore } from "./tasks.ts";
import type { AgentBinding, AgentPorts } from "./trigger-agent.ts";

/** A thread that is not idle waits this long, and so does a task behind another of the same agent: not an attempt (M11R71). */
export const THREAD_BUSY_MS = 10_000;
/** A thread that is busy (a run, a prompt, another task) is what the task waits for, not a session slot (R16). */
const BUSY = { reason: "thread_busy" } as const;
/** No worker was free for the thread's reopen: the same wait as any other task (M10R154). */
const CAPACITY_MS = 30_000;
/** Ended thread tasks looked at when the agents are bound: the newest, a bound on the work. */
const SETTLE_CARDS = 200;

type Settle = (row: TaskRow, from: readonly TaskState[], to: TaskState, change?: Move) => boolean;

/**
 * What the prompt's first line calls the task. `schedule` and `task` have a card of ours; a reminder and a delegation have
 * a request's (Task 12). The plan's origin names are `remind` (M11R80) and `delegate` (M11R78), W5-R39.
 */
export type ThreadKind = "schedule" | "task" | "reminder" | "delegation";
export const threadKindOf = (origin: string): ThreadKind =>
  origin === "schedule"
    ? "schedule"
    : origin === "remind"
      ? "reminder"
      : origin === "delegate"
        ? "delegation"
        : "task";

// Controls, format characters (bidi, zero-width) and line or paragraph separators: a title is one line of ours.
// eslint-disable-next-line no-control-regex -- the control characters are what this pattern removes
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]+/gu;
const TITLE_CHARS = 120;

/**
 * The one fixed line a pap-sent prompt starts with (M11R71): the model knows where it comes from, and the client folds a
 * user message with this first line under the card before it. The title cannot end the line early or fake a second one.
 */
export function threadPromptLine(kind: ThreadKind, title: string): string {
  const clean = [...title.replace(HIDDEN, " ").replace(/[[\]]/g, " ").replace(/ {2,}/g, " ").trim()]
    .slice(0, TITLE_CHARS)
    .join("");
  return `[pap ${kind} · ${clean}] Sent by pap for the owner, not typed by them.`;
}

/**
 * M11R78's first line, worded in one place: a delegation names its requester and never says "owner". Where the files go
 * differs by the task's target (the target's outbox for a thread task, its working folder for an isolated one).
 */
export const delegationLine = (from: string, placement: string): string =>
  `[pap delegation \u00b7 from ${from}] A request from another agent, not from the owner. Put files meant for ${from} ${placement} and cite their absolute paths.`;

/**
 * W5-R44: the one exception to the tainted-prompt guard. A tainted reminder may prompt the thread only when the thread
 * session is the one that set it: taint only grows within a session until a reset, so that session launders nothing.
 */
const mayCarryTaint = (row: TaskRow, threadSession: string | null): boolean =>
  row.origin === "remind" && row.set_by_session !== null && row.set_by_session === threadSession;

/** The words between the fence tags of a stored prompt: what the cards show of a request or a note (fenced again by the UI). */
const wordsOf = (prompt: string): string =>
  /^<untrusted [^>]*>\n([\s\S]*)\n<\/untrusted id="[^"]*">$/.exec(prompt)?.[1] ?? "";

/** The card of a reminder that could not be delivered: pap's own words, in the thread it was meant for. */
const NOT_DELIVERED = PAP_TEXT.reminderNotDelivered;

export interface ThreadStartDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly binding: AgentBinding;
  readonly store: Pick<TaskStore, "ofAgent" | "get" | "endedThreadTasks">;
  readonly sessions: Pick<SessionsAutomationPort, "admits" | "promptPending">;
  /** The tasks being started, by owner, and the ones put off until a time: the runner's own maps. */
  readonly starting: Map<string, string>;
  readonly putOff: Map<string, PutOff>;
  /** The runner's state change. */
  readonly settle: Settle;
  /** The commit of a start (the runner's, shared). */
  readonly launch: Launch;
}

/** A code of ours, never text from outside. */
const reasonOf = (error: unknown): string => (error instanceof PapError ? error.code : "start_failed");

/**
 * The thread target (M11R71): a task that prompts the agent's own trusted thread. One thread task of an agent at a time,
 * and only into an idle thread. Everything between the last look at the agent and the `running` mark is one synchronous
 * step (M11R75, M11R183): a pause or a delete lands before it or after it, never inside.
 */
export function createThreadStart(deps: ThreadStartDeps) {
  const { clock, logger, store } = deps;
  /** The thread's open run, by session: the task it belongs to (null: the owner's own). A task aborts only its own run. */
  const openRun = new Map<string, string | null>();

  const defer = (
    row: TaskRow,
    ms: number,
    wait: Pick<PutOff, "reason" | "used" | "max"> = { reason: "session_slots" },
  ): Settlement => {
    const until = clock.now() + ms;
    deps.putOff.set(row.id, { until, ...wait });
    return { outcome: "defer", until };
  };

  function fail(row: TaskRow, reason: string): Settlement {
    deps.settle(row, ["queued"], reason === "stopped" ? "cancelled" : "failed", { reason });
    return { outcome: "done" };
  }

  /** A tainted prompt that may not reach the thread: the task fails, and a reminder says why in the thread it was meant for. */
  function failTainted(ports: AgentPorts, row: TaskRow): Settlement {
    if (row.origin === "remind")
      try {
        ports.events.runCard(row.owner_id, row.agent_id as string, row.id, "task", {
          title: NOT_DELIVERED,
          state: "failed",
        });
      } catch (error) {
        logger.warn("agent_thread_card_failed", { err: error });
      }
    return fail(row, "tainted_prompt");
  }

  /** Another thread task of the agent runs, waits for a quota, or is being started now. */
  function otherThreadTask(row: TaskRow): boolean {
    const agentId = row.agent_id as string;
    const live = store.ofAgent(row.owner_id, agentId, ["running", "limited"]);
    if (live.some((task) => task.target === "thread" && task.id !== row.id)) return true;
    return [...deps.starting.keys()].some((id) => {
      const task = id === row.id ? undefined : store.get(id);
      return task?.owner_id === row.owner_id && task.agent_id === agentId && task.target === "thread";
    });
  }

  /** The agent's thread, opened when it has none (or an archived one); what refuses the open answers for the task. */
  async function threadOf(
    ports: AgentPorts,
    row: TaskRow,
  ): Promise<{ sessionId: string } | { settlement: Settlement }> {
    try {
      return await ports.threads.open(row.owner_id, row.agent_id as string);
    } catch (error) {
      if (error instanceof PapError && error.code === "capacity")
        return { settlement: defer(row, CAPACITY_MS, capacityWait(error)) };
      if (error instanceof PapError && error.code === "session_busy")
        return { settlement: defer(row, THREAD_BUSY_MS, BUSY) };
      if (error instanceof PapError && error.code === "agent_paused") {
        deps.settle(row, ["queued"], "cancelled", { reason: "quarantined" });
        return { settlement: { outcome: "done" } };
      }
      return { settlement: fail(row, reasonOf(error)) };
    }
  }

  /** The card of a task that is about to be prompted (M11R71); a failing card never stops the task. */
  function writeCard(ports: AgentPorts, row: TaskRow, kind: ThreadKind): void {
    try {
      if (kind === "delegation") {
        // The request, in the TARGET's thread: another agent's words, shown fenced, never a prompt of the owner's.
        const from = row.requested_by === null ? null : ports.registry.get(row.owner_id, row.requested_by);
        if (from && row.requested_by !== null)
          ports.events.delegation(row.owner_id, row.agent_id as string, row.id, {
            fromAgentId: row.requested_by,
            fromName: from.name,
            state: "running",
            summary: wordsOf(row.prompt),
            tainted: false,
            isolated: false,
          });
        return;
      }
      // A reminder's card is its note and the time it was set (M11R80).
      if (kind === "reminder")
        ports.events.reminder(row.owner_id, row.agent_id as string, row.id, {
          note: wordsOf(row.prompt),
          setAt: row.created_at,
        });
      else
        ports.events.runCard(row.owner_id, row.agent_id as string, row.id, kind, {
          title: row.title,
          state: "running",
        });
    } catch (error) {
      logger.warn("agent_thread_card_failed", { err: error });
    }
  }

  async function start(row: TaskRow, signal: AbortSignal): Promise<Settlement> {
    const ports = deps.binding.ports();
    const agentId = row.agent_id;
    if (!ports || agentId === null) return fail(row, "thread_unavailable");
    const agent = ports.registry.get(row.owner_id, agentId);
    if (agent === null) return fail(row, "not_found");
    // Carry 1: the thread is trusted, a prompt with outside text in it never reaches it. Fails closed, before anything opens.
    if (row.tainted === 1 && !mayCarryTaint(row, agent.threadSessionId)) return failTainted(ports, row);
    if (agent.quarantinedAt !== null || requesterQuarantined(ports, row)) {
      deps.settle(row, ["queued"], "cancelled", { reason: "quarantined" });
      return { outcome: "done" };
    }
    if (agent.paused) return defer(row, PAUSED_MS, { reason: "paused" });
    if (otherThreadTask(row)) return defer(row, THREAD_BUSY_MS, BUSY);
    const opened = await threadOf(ports, row);
    if ("settlement" in opened) return opened.settlement;
    if (signal.aborted) return { outcome: "retry", code: "deadline" };
    const { sessionId } = opened;

    // From here to the `running` mark nothing is awaited.
    const now = ports.registry.get(row.owner_id, agentId);
    if (now === null) return fail(row, "not_found");
    if (now.quarantinedAt !== null || requesterQuarantined(ports, row)) {
      deps.settle(row, ["queued"], "cancelled", { reason: "quarantined" });
      return { outcome: "done" };
    }
    if (now.paused) return defer(row, PAUSED_MS, { reason: "paused" });
    if (otherThreadTask(row)) return defer(row, THREAD_BUSY_MS, BUSY);
    const thread = ports.sessions.threadState(row.owner_id, sessionId);
    if (
      thread === null ||
      thread.archived ||
      thread.running ||
      thread.starting ||
      thread.needsInput ||
      deps.sessions.promptPending(row.owner_id, sessionId)
    )
      return defer(row, THREAD_BUSY_MS, BUSY);
    if (!deps.sessions.admits(row.owner_id, sessionId)) return defer(row, CAPACITY_MS);
    // Carry 1: checked again right before the mark.
    if (row.tainted === 1 && !mayCarryTaint(row, sessionId)) return failTainted(ports, row);
    const kind = threadKindOf(row.origin);
    const head = promptHeadOf(ports, row, kind);
    if (head === null) return fail(row, "not_found");
    // Cancelled meanwhile: the thread is not ours to discard, and the effect is spent.
    return deps.launch(row, sessionId, {
      text: `${head}\n\n${row.prompt}`,
      beforePrompt: () => writeCard(ports, row, kind),
    });
  }

  /**
   * The first fixed line, by origin (W5-R39). A delegation is never said to come from the owner: the requester is named, and
   * a requester that is gone leaves no line to write, so the task fails (null).
   */
  function promptHeadOf(ports: AgentPorts, row: TaskRow, kind: ThreadKind): string | null {
    if (kind === "reminder")
      return `[pap reminder \u00b7 set by you at ${new Date(row.created_at).toISOString()}] Not a message from the owner.`;
    if (kind !== "delegation") return threadPromptLine(kind, row.title);
    const from = row.requested_by === null ? null : ports.registry.get(row.owner_id, row.requested_by);
    if (!from || row.agent_id === null) return null;
    const home = ports.registry.homeOf(row.owner_id, row.agent_id);
    return delegationLine(from.name, `under ${home}/outbox/${row.id}/`);
  }

  /** The task's end (the runner's end hook): its card moves to the state, the time and the cost it ended with. */
  function ended(row: TaskRow, state: TaskState, only: { whileRunning: true } | undefined = undefined): void {
    const ports = deps.binding.ports();
    const kind = threadKindOf(row.origin);
    if (!ports || row.agent_id === null) return;
    if (state === "queued" || state === "running" || state === "limited") return;
    if (kind === "delegation") {
      // The request's card follows the task (M11R71); a failing card never undoes the end.
      try {
        if (only) ports.events.delegationEnded(row.owner_id, row.agent_id, row.id, state, only);
        else ports.events.delegationEnded(row.owner_id, row.agent_id, row.id, state);
      } catch (error) {
        logger.warn("agent_thread_card_failed", { err: error });
      }
      return;
    }
    if (kind !== "schedule" && kind !== "task") return;
    const over = store.get(row.id);
    const started = over?.started_at ?? null;
    const finished = over?.ended_at ?? null;
    const { usd, billing } = ports.spend.taskRuns(row.id);
    try {
      const patch = {
        state,
        durationMs: started !== null && finished !== null ? finished - started : null,
        costUsd: usd,
        billing,
      };
      if (only) ports.events.runCardEnded(row.owner_id, row.agent_id, row.id, patch, only);
      else ports.events.runCardEnded(row.owner_id, row.agent_id, row.id, patch);
    } catch (error) {
      logger.warn("agent_thread_card_failed", { err: error });
    }
  }

  return {
    start,
    ended,
    /** The thread's runs, as the runner hears them: which one is open, and whose it is. */
    runStarted(event: RunStartEvent): void {
      openRun.set(event.sessionId, event.taskId);
    },
    runEnded(event: { readonly sessionId: string }): void {
      openRun.delete(event.sessionId);
    },
    /** A task aborts the run it prompted, never one that is the owner's or another task's (M11R71). */
    mayAbort(row: TaskRow): boolean {
      if (row.target !== "thread" || row.session_id === null) return true;
      return !openRun.has(row.session_id) || openRun.get(row.session_id) === row.id;
    },
    /**
     * The cards of thread tasks that ended while the agents were not bound yet (the boot recovers the tasks before the
     * agents module binds): moved now, and only the ones still running (a final card is never rewritten).
     */
    settleCards(): void {
      for (const row of store.endedThreadTasks(SETTLE_CARDS)) ended(row, row.state, { whileRunning: true });
    },
  };
}
export type ThreadStart = ReturnType<typeof createThreadStart>;
