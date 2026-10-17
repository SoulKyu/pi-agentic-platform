import { AUTOMATION_LIMITS, type AutomationSettings, presetOfTools } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { enqueueEffect, type Outbox } from "../../kernel/outbox/index.ts";
import type { Gates } from "./gates.ts";
import type { TriggerRecord } from "./triggers.ts";
import type { AutomationEvents } from "./events.ts";
import { type FireVerdict, firedWithin, writeJournal } from "./fire-journal.ts";
import { type FenceSource, RENDERED_PROMPT_MAX, renderPrompt } from "./prompt.ts";
import type { TaskViews } from "./task-view.ts";
import { detailOf, type TaskPolicySnapshot, type TaskStore } from "./tasks.ts";

/** Which gates a fire passes through. A manual fire of a disabled trigger is the owner asking by hand (M10R57). */
export interface GateSet {
  readonly exemptDisabled: boolean;
}

/** What a retry keeps of the task it repeats: the prompt as it was sent, its taint and its policy (M10R41). */
export interface RetryOf {
  readonly taskId: string;
  readonly prompt: string;
  readonly tainted: boolean;
  /** The policy the task had; null: the trigger's current tools, mode and env (a token's retry, M10R41 amended). */
  readonly policy: TaskPolicySnapshot | null;
  /** The caps the task had; null: the trigger's current ones (a token's retry, like the policy). */
  readonly caps: {
    readonly maxRunMs: number;
    readonly maxRunUsd: number | null;
    readonly retryOnInterrupt: boolean;
  } | null;
}

export interface FireInput {
  readonly ownerId: string;
  readonly source: "schedule" | "webhook" | "feed" | "manual" | "retry";
  readonly payload: { readonly text: string; readonly source: FenceSource } | null;
  readonly precheck: string | null;
  readonly dedupKey: string | null;
  readonly title: string;
  readonly detail: string | null;
  /** A webhook alert delivery whose alerts are all resolved: refused when the trigger says `onResolved: skip`. */
  readonly allResolved?: boolean;
  /** The daily budget gates this task (a token's fire, a schedule, a webhook); false for a browser's manual fire. */
  readonly gated: boolean;
  readonly gates: GateSet;
  /** Set by Retry: the prompt is not rendered again. */
  readonly retry: RetryOf | null;
}

export interface FireResult {
  readonly verdict: FireVerdict;
  readonly taskId?: string;
  readonly detail?: string;
}

export interface FireDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: TaskStore;
  readonly triggers: { get(ownerId: string, id: string): TriggerRecord | null };
  readonly marks: { fired(ownerId: string, triggerId: string, at: number): void };
  readonly settings: { automation(ownerId: string): AutomationSettings };
  readonly gates: Pick<Gates, "over">;
  readonly outbox: Pick<Outbox, "poke">;
  readonly events: AutomationEvents;
  readonly views: TaskViews;
  readonly newId: () => string;
  /** An agent trigger's agent is paused or quarantined (M11R75): its fires are journaled `paused`. */
  readonly agentPaused?: (ownerId: string, agentId: string) => boolean;
}

/**
 * The one fire path (M10R34). In one synchronous transaction, with no `await` between the checks and the writes, it
 * re-reads the trigger, runs the gates in order (M10R57), renders the prompt, writes the journal line and, when it fires, the
 * task and its `task.start` effect. The outbox is poked after the commit, never inside it.
 */
export function createFire(deps: FireDeps) {
  const { db, clock, store } = deps;

  function refuse(
    record: TriggerRecord,
    input: FireInput,
    verdict: FireVerdict,
    detail: string | null,
  ): FireResult {
    writeJournal(db, {
      triggerId: record.id,
      ownerId: record.ownerId,
      source: input.source,
      verdict,
      detail,
      taskId: null,
      dedupKey: input.dedupKey,
      at: clock.now(),
    });
    return detail === null ? { verdict } : { verdict, detail };
  }

  function decide(triggerId: string, revision: number, input: FireInput): FireResult & { fired?: string } {
    const record = deps.triggers.get(input.ownerId, triggerId);
    // Gone: its journal went with it (cascade), so there is nothing to write a line in.
    if (record === null) return { verdict: "error", detail: "changed" };
    const trigger = record.input;
    if (record.revision !== revision || trigger === null) return refuse(record, input, "error", "changed");
    if (!record.enabled && !input.gates.exemptDisabled) return refuse(record, input, "disabled", null);
    if (deps.settings.automation(input.ownerId).paused) return refuse(record, input, "paused", null);
    if (record.agentId !== null && deps.agentPaused?.(input.ownerId, record.agentId))
      return refuse(record, input, "paused", null);
    const { source } = trigger;
    const hook = input.source === "webhook" && source.type === "webhook" ? source : null;
    if (hook && input.allResolved && hook.onResolved === "skip")
      return refuse(record, input, "resolved", null);
    // The budget (M10R66): a token's fire, a schedule, a webhook, a feed and their retries; not a browser's manual fire.
    // The owner's line, the trigger's and the agent's own (M11R74): the trigger names the agent.
    if (input.gated && deps.gates.over(input.ownerId, record.id))
      return refuse(record, input, "budget", null);
    if (
      hook &&
      input.dedupKey !== null &&
      firedWithin(db, record.id, input.dedupKey, hook.dedupMinutes * 60_000, clock.now())
    )
      return refuse(record, input, "dedup", null);
    if (store.queuedOfTrigger(record.id) >= AUTOMATION_LIMITS.queuedPerTrigger)
      return refuse(record, input, "queue_full", null);

    const at = clock.now();
    const { retry } = input;
    const rendered = retry
      ? { text: retry.prompt, fenced: retry.tainted }
      : renderPrompt(trigger.prompt, {
          payload: input.payload,
          precheck: input.precheck,
          trigger: record.name,
          firedAt: new Date(at).toISOString(),
        });
    if (rendered.text.length > RENDERED_PROMPT_MAX) return refuse(record, input, "error", "prompt_too_large");

    const { execution } = trigger;
    const policy: TaskPolicySnapshot = retry?.policy ?? {
      mode: execution.mode ?? "supervised",
      tools: [...execution.tools],
      preset: presetOfTools(execution.tools),
      env: [...execution.env],
    };
    const taskId = deps.newId();
    writeJournal(db, {
      triggerId: record.id,
      ownerId: record.ownerId,
      source: input.source,
      verdict: "fired",
      detail: null,
      taskId,
      dedupKey: input.dedupKey,
      at,
    });
    store.insert({
      id: taskId,
      ownerId: record.ownerId,
      triggerId: record.id,
      origin: input.source,
      cwd: record.cwd,
      prompt: rendered.text,
      tainted: rendered.fenced,
      gated: input.gated,
      policy,
      title: input.title,
      detail: detailOf(input.detail),
      retryOf: retry?.taskId ?? null,
      retryOnInterrupt: retry?.caps?.retryOnInterrupt ?? execution.retryOnInterrupt,
      maxRunMs: retry?.caps?.maxRunMs ?? execution.maxRunMinutes * 60_000,
      maxRunUsd: retry?.caps ? retry.caps.maxRunUsd : (execution.maxRunUsd ?? null),
      at,
      agentId: record.agentId,
      target: execution.agent?.target ?? null,
    });
    enqueueEffect(db, { kind: "task.start", ownerId: record.ownerId, payload: { taskId } }, at);
    deps.marks.fired(record.ownerId, record.id, at);
    return { verdict: "fired", taskId, fired: taskId };
  }

  return function fire(triggerId: string, revision: number, input: FireInput): FireResult {
    const decided = db.transaction(() => decide(triggerId, revision, input));
    const { fired, ...result } = decided;
    if (fired !== undefined) {
      // The commit is done: a board that cannot be told must not turn a fired task into an error the sender retries.
      try {
        const row = store.get(fired);
        if (row)
          deps.events.emit({ kind: "task", ownerId: row.owner_id, task: deps.views(row), previous: null });
      } catch (error) {
        deps.logger.warn("task_event_failed", { err: error });
      }
      deps.outbox.poke();
    }
    return result;
  };
}
export type Fire = ReturnType<typeof createFire>;
