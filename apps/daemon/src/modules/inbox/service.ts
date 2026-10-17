import { randomUUID } from "node:crypto";
import {
  INBOX_LIMITS,
  type InboxCursor,
  type InboxFilter,
  type InboxItem,
  type InboxStreamEvent,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { AutomationEvent, AutomationEvents } from "../automation/index.ts";
import { createAgentItems } from "./agent-items.ts";
import { createInboxStore, type NewItem } from "./store.ts";

/** What the Inbox asks the automation module about a task it hears of. */
export interface InboxTaskInfo {
  readonly ownerId: string;
  readonly triggerName: string;
  readonly sessionId: string | null;
  /** The agent whose task it is (M11R92); absent or null for a trigger's own task. */
  readonly agentId?: string | null;
}

export interface InboxDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  readonly events: Pick<AutomationEvents, "on">;
  readonly tasks: { find(taskId: string): InboxTaskInfo | null };
  /** A database written by a newer pap: the Inbox hears nothing and writes nothing (M10R150). */
  readonly readOnly: boolean;
}

const QUESTION = "task_needs_input";
/** The task states that become an info item; `cancelled` is the owner's own move and gets none (M10R46). */
const INFO_KINDS = {
  done: "task_done",
  failed: "task_failed",
  interrupted: "task_interrupted",
  limited: "task_limited",
} as const;
const OVER = new Set(["done", "failed", "interrupted", "cancelled"]);
const FULL_LOG_MS = 60_000;
const NAME_CHARS = 200;

// Controls, format characters (bidi, zero-width) and line or paragraph separators: never shown, never stored.
// eslint-disable-next-line no-control-regex -- the control characters are what this pattern removes
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The trigger's name as the Inbox keeps it. It is the owner's text, but a deleted trigger leaves a task's title, which can come from a payload. */
function nameOf(text: string): string {
  const clean = [...text.replace(HIDDEN, "")].slice(0, NAME_CHARS).join("").trim();
  return clean === "" ? "?" : clean;
}

type Snapshot = Extract<InboxStreamEvent, { kind: "snapshot" }>;

/** The Inbox of M10 (M10R46 to M10R49): one item per task and kind, fed by what the runner says, kept per owner. */
export function createInbox(deps: InboxDeps) {
  const { clock, logger } = deps;
  const store = createInboxStore(deps.db);
  const fullLoggedAt = new Map<string, number>();

  function publish(ownerId: string, event: InboxStreamEvent): void {
    try {
      deps.hub.publish("inbox", ownerId, event);
    } catch (error) {
      logger.warn("inbox_publish_failed", { kind: event.kind, err: error });
    }
  }

  function announce(ownerId: string, items: readonly InboxItem[]): void {
    for (const item of items) publish(ownerId, { kind: "item", item });
    publish(ownerId, { kind: "counts", ...store.counts(ownerId) });
  }

  /** Room for one more info item: the oldest read info item goes when the owner is at the cap; false (and a log) when none can. */
  function roomFor(ownerId: string): boolean {
    if (store.count(ownerId) < INBOX_LIMITS.perOwner) return true;
    if (store.evictOldestReadInfo(ownerId)) return true;
    const now = clock.now();
    if (now - (fullLoggedAt.get(ownerId) ?? -FULL_LOG_MS) >= FULL_LOG_MS) {
      fullLoggedAt.set(ownerId, now);
      logger.warn("inbox_full", { ownerId });
    }
    return false;
  }

  const agentItems = createAgentItems({
    store,
    clock,
    logger,
    roomFor,
    announce,
    counts: (ownerId) => publish(ownerId, { kind: "counts", ...store.counts(ownerId) }),
  });

  function newItem(
    ownerId: string,
    kind: string,
    toHandle: boolean,
    task: InboxTaskInfo,
    taskId: string,
    costUsd: number | null,
  ): NewItem {
    return {
      id: randomUUID(),
      ownerId,
      kind,
      toHandle,
      taskId,
      sessionId: task.sessionId,
      triggerName: nameOf(task.triggerName),
      costUsd,
      at: clock.now(),
      agentId: task.agentId ?? null,
    };
  }

  function onAttention(taskId: string, needsInput: boolean): void {
    const task = deps.tasks.find(taskId);
    if (!task) return;
    const changed = needsInput
      ? store.openQuestion(newItem(task.ownerId, QUESTION, true, task, taskId, null))
      : store.resolve(taskId, QUESTION, "answered", clock.now());
    if (changed) announce(task.ownerId, [changed]);
  }

  function onTimeout(taskId: string): void {
    const task = deps.tasks.find(taskId);
    const changed = task ? store.resolve(taskId, QUESTION, "timed_out", clock.now()) : null;
    if (task && changed) announce(task.ownerId, [changed]);
  }

  function onTask(event: Extract<AutomationEvent, { kind: "task" }>): void {
    const { ownerId, task } = event;
    const changed: InboxItem[] = [];
    // A question the task leaves behind is closed with it: it could never be answered now.
    if (OVER.has(task.state)) {
      const closed = store.resolve(task.id, QUESTION, null, clock.now());
      if (closed) changed.push(closed);
    }
    const kind = INFO_KINDS[task.state as keyof typeof INFO_KINDS];
    // The same ending heard twice writes nothing, and costs the owner no old item either.
    if (kind && !store.byTaskKind(task.id, kind) && roomFor(ownerId)) {
      const from = {
        ownerId,
        triggerName: task.triggerName,
        sessionId: task.sessionId,
        agentId: task.agentId,
      };
      if (store.insertInfo(newItem(ownerId, kind, false, from, task.id, task.costUsd))) {
        const written = store.byTaskKind(task.id, kind);
        if (written) changed.push(written);
      }
    }
    if (changed.length > 0) announce(ownerId, changed);
  }

  function snapshot(ownerId: string): Snapshot {
    const { open, others } = store.snapshotItems(ownerId);
    const head = { kind: "snapshot" as const, ...store.counts(ownerId), items: [], truncated: false };
    // Under the frame budget (M2R54): the open questions first, then as many others as fit, with `truncated`.
    let used = sizeOf(head);
    const items: InboxItem[] = [];
    for (const item of [...open, ...others]) {
      const size = sizeOf(item) + 1;
      if (used + size > PAGE_BYTES) return { ...head, items, truncated: true };
      used += size;
      items.push(item);
    }
    return { ...head, items };
  }

  deps.hub.registerSnapshot("inbox", (ownerId) => snapshot(ownerId));
  const stop = deps.readOnly
    ? () => {}
    : deps.events.on((event) => {
        if (event.kind === "attention") onAttention(event.taskId, event.needsInput);
        else if (event.kind === "attention_timeout") onTimeout(event.taskId);
        else onTask(event);
      });

  return {
    snapshot,
    /** The port M11's agents, delegations and memory write the Inbox through (M11R91). */
    agentItems,
    list(
      ownerId: string,
      before: InboxCursor | undefined,
      filter?: InboxFilter,
    ): { items: InboxItem[]; hasMore: boolean } {
      const rows = store.page(ownerId, before, INBOX_LIMITS.page, filter);
      return { items: rows.slice(0, INBOX_LIMITS.page), hasMore: rows.length > INBOX_LIMITS.page };
    },
    markRead(ownerId: string, params: { ids?: string[]; all?: true }): { updated: number } {
      const changed = store.markRead(ownerId, params.all ? null : (params.ids ?? []), clock.now());
      if (changed.length > 0) {
        // A client holds the open questions and the newest few: older rows that changed are not worth an event each.
        const shown = [...changed]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, INBOX_LIMITS.clientOthers);
        announce(ownerId, shown);
      }
      return { updated: changed.length };
    },
    /** Housekeeping's hourly pass (M10R49): read items whose question is resolved go 30 days after their creation. */
    retention(): void {
      if (!deps.readOnly) store.removeReadBefore(clock.now() - INBOX_LIMITS.retentionMs);
    },
    stop,
  };
}
export type Inbox = ReturnType<typeof createInbox>;
