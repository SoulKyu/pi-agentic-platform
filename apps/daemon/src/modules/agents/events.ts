import {
  AGENT_EVENT_DATA,
  AGENT_EVENT_LIMITS,
  type AgentEventKind,
  AgentEventView,
  IsolatedCardData,
  type NotifyCardData,
  type RunCardData,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cutUnits, LONE_SURROGATE } from "../../kernel/text.ts";

/** An isolated run's summary: its last assistant text, cut here (M11R69). Untrusted text, shown fenced. */
export const SUMMARY_CHARS = AGENT_EVENT_LIMITS.summaryChars;
/** The newest cards an agent keeps; older ones go as new ones arrive (an agent that fires all day cannot fill the table). */
export const EVENTS_PER_AGENT = 500;

// Controls but tab and new line, format characters (bidi, zero-width), line and paragraph separators: never stored.
// eslint-disable-next-line no-control-regex -- the control characters are what this pattern removes
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu;

export interface AgentEventsDeps {
  readonly db: Db;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Pick<Logger, "warn">;
  /** +1 on the rail's badge (the card is unread until the owner reads the thread). */
  readonly unread: { bump(ownerId: string, agentId: string): void };
  /** A card was written or moved: the `agents` stream tells the open agent tab (M11R72). A throw is logged. */
  readonly written?: (ownerId: string, agentId: string, eventId: number) => void;
}

const cleaned = (text: string | null): string =>
  [...(text ?? "").replace(HIDDEN, "")].slice(0, SUMMARY_CHARS).join("");

/** Model text as a card keeps it: hidden characters gone, at most `max` UTF-16 units (what the schema counts), never half a pair. */
const shown = (text: string | null, max: number): { text: string; clipped: boolean } => {
  const clean = (text ?? "").replace(LONE_SURROGATE, "\uFFFD").replace(HIDDEN, "");
  return { text: cutUnits(clean, max), clipped: clean.length > max };
};

interface EventRow {
  readonly id: number;
  readonly kind: string;
  readonly task_id: string | null;
  readonly data: string;
  readonly at: number;
}

/** A stored row as the wire reads it; a row that no longer parses is left out, never half-shown. */
function viewOf(row: EventRow): AgentEventView | null {
  try {
    const parsed = AgentEventView.safeParse({
      id: row.id,
      kind: row.kind,
      at: row.at,
      taskId: row.task_id,
      data: JSON.parse(row.data) as unknown,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The thread's display-only cards (decision 29): written here, read by `agents.events`. A card is never sent to a model.
 * It is written only for an agent of the owner who is still there, and an agent keeps its newest `EVENTS_PER_AGENT`.
 */
export function createAgentEvents(deps: AgentEventsDeps) {
  const { db } = deps;

  /** Told after the commit: a failing listener never undoes a card. */
  function told(ownerId: string, agentId: string, eventId: number, unread: boolean): void {
    try {
      if (unread) deps.unread.bump(ownerId, agentId);
    } catch (error) {
      deps.logger.warn("agent_event_unread_failed", { err: error });
    }
    try {
      deps.written?.(ownerId, agentId, eventId);
    } catch (error) {
      deps.logger.warn("agent_event_hint_failed", { err: error });
    }
  }

  /** One validated card; the id, or null when nothing was written (a bad shape, an agent that is not the owner's). */
  function write(
    ownerId: string,
    agentId: string,
    kind: AgentEventKind,
    taskId: string | null,
    data: unknown,
  ): number | null {
    const parsed = AGENT_EVENT_DATA[kind].safeParse(data);
    if (!parsed.success) {
      deps.logger.warn("agent_event_refused", { kind, agentId });
      return null;
    }
    const id = db.transaction(() => {
      const inserted = db.get<{ id: number }>(
        `INSERT INTO agent_events (agent_id, owner_id, kind, task_id, data, at)
         SELECT $agentId, $ownerId, $kind, $taskId, $data, $at
         WHERE EXISTS (SELECT 1 FROM agents WHERE id = $agentId AND owner_id = $ownerId) RETURNING id`,
        { agentId, ownerId, kind, taskId, data: JSON.stringify(parsed.data), at: deps.clock.now() },
      );
      if (!inserted) return null;
      db.run(
        `DELETE FROM agent_events WHERE agent_id = $agentId AND id NOT IN
           (SELECT id FROM agent_events WHERE agent_id = $agentId ORDER BY id DESC LIMIT $keep)`,
        { agentId, keep: EVENTS_PER_AGENT },
      );
      return inserted.id;
    });
    if (id === null) return null;
    told(ownerId, agentId, id, true);
    return id;
  }

  return {
    write,
    /** The card of an isolated task that ended `done` or `failed`; false when nothing was written. */
    isolated(
      ownerId: string,
      agentId: string,
      taskId: string,
      card: Omit<IsolatedCardData, "summary" | "durationMs"> & {
        readonly summary: string | null;
        readonly durationMs?: number | null;
      },
    ): boolean {
      return (
        write(ownerId, agentId, "isolated", taskId, {
          durationMs: null,
          ...card,
          summary: cleaned(card.summary),
        }) !== null
      );
    },

    /**
     * The result of a delegated task, in the requester's thread (M11R79). `fromAgentId` is the agent that answered. The
     * summary is the target run's last words: untrusted, stripped and clipped here, shown fenced, never sent to a model.
     */
    delegation(
      ownerId: string,
      requesterId: string,
      taskId: string,
      card: {
        readonly fromAgentId: string;
        readonly fromName: string;
        readonly state: RunCardData["state"];
        readonly summary: string | null;
        readonly tainted: boolean;
        readonly isolated: boolean;
      },
    ): boolean {
      const summary = shown(card.summary, AGENT_EVENT_LIMITS.delegationChars);
      return (
        write(ownerId, requesterId, "delegation", taskId, {
          ...card,
          summary: summary.text,
          clipped: summary.clipped,
        }) !== null
      );
    },

    /**
     * The delegation's request card in the target's thread, moved to the state its task ended with (M11R71). It keeps its
     * place; only the card of this agent and task changes (the requester's result card is another agent's row).
     */
    delegationEnded(
      ownerId: string,
      agentId: string,
      taskId: string,
      state: RunCardData["state"],
      only?: { readonly whileRunning: true },
    ): boolean {
      const moved = db.transaction(() => {
        const row = db.get<EventRow>(
          `SELECT id, kind, task_id, data, at FROM agent_events
           WHERE agent_id = $agentId AND owner_id = $ownerId AND task_id = $taskId AND kind = 'delegation'
           ORDER BY id DESC LIMIT 1`,
          { agentId, ownerId, taskId },
        );
        if (!row) return null;
        const was = JSON.parse(row.data) as { state?: unknown };
        // A boot-time settle moves a card that is still running, never one that already says how it ended.
        if (only?.whileRunning === true && was.state !== "running") return null;
        const parsed = AGENT_EVENT_DATA.delegation.safeParse({ ...was, state });
        if (!parsed.success) return null;
        db.run("UPDATE agent_events SET data = $data WHERE id = $id", {
          id: row.id,
          data: JSON.stringify(parsed.data),
        });
        return row.id;
      });
      if (moved === null) return false;
      told(ownerId, agentId, moved, state === "failed");
      return true;
    },

    /** The card of a reminder that fires, written right before its prompt (M11R80): the note is the agent's own words. */
    reminder(
      ownerId: string,
      agentId: string,
      taskId: string,
      card: { readonly note: string; readonly setAt: number },
    ): boolean {
      return (
        write(ownerId, agentId, "reminder", taskId, {
          note: shown(card.note, AGENT_EVENT_LIMITS.noteChars).text,
          setAt: card.setAt,
        }) !== null
      );
    },

    /** The notification card of `agent.notify` (M11R100): the agent's own words, shown as text in pap's frame; false when nothing was written. */
    notify(ownerId: string, agentId: string, card: NotifyCardData): boolean {
      return write(ownerId, agentId, "notify", null, card) !== null;
    },

    /** The card of a thread task, written right before its prompt (M11R71): `schedule` for a trigger's fire, else `task`. */
    runCard(
      ownerId: string,
      agentId: string,
      taskId: string,
      kind: "schedule" | "task",
      card: RunCardData,
    ): number | null {
      return write(ownerId, agentId, kind, taskId, card);
    },

    /**
     * The same card when its task ended: the state, the time and the cost. It keeps its place in the thread (`at` stays);
     * a failure counts unread again, so the rail can say it. False when the card is gone or the move is not valid.
     */
    runCardEnded(
      ownerId: string,
      agentId: string,
      taskId: string,
      patch: Partial<RunCardData>,
      only?: { readonly whileRunning: true },
    ): boolean {
      const moved = db.transaction(() => {
        const row = db.get<EventRow>(
          `SELECT id, kind, task_id, data, at FROM agent_events
           WHERE agent_id = $agentId AND owner_id = $ownerId AND task_id = $taskId AND kind IN ('schedule', 'task')
           ORDER BY id DESC LIMIT 1`,
          { agentId, ownerId, taskId },
        );
        if (!row) return null;
        const was = JSON.parse(row.data) as { state?: unknown };
        // A boot-time settle moves a card that is still running, never one that already says how it ended.
        if (only?.whileRunning === true && was.state !== "running") return null;
        const parsed = AGENT_EVENT_DATA.task.safeParse({ ...was, ...patch });
        if (!parsed.success) return null;
        db.run("UPDATE agent_events SET data = $data WHERE id = $id", {
          id: row.id,
          data: JSON.stringify(parsed.data),
        });
        return { id: row.id, failed: parsed.data.state === "failed" };
      });
      if (!moved) return false;
      told(ownerId, agentId, moved.id, moved.failed);
      return true;
    },

    /** One page, newest first, older than `before` (`at`, then `id`); `more` says an older card exists. */
    list(
      ownerId: string,
      agentId: string,
      before?: { readonly at: number; readonly id: number },
    ): { events: AgentEventView[]; more: boolean; next: { at: number; id: number } | null } {
      const rows = db.all<EventRow>(
        `SELECT id, kind, task_id, data, at FROM agent_events
         WHERE agent_id = $agentId AND owner_id = $ownerId
           AND ($at IS NULL OR at < $at OR (at = $at AND id < $id))
         ORDER BY at DESC, id DESC LIMIT $limit`,
        {
          agentId,
          ownerId,
          at: before?.at ?? null,
          id: before?.id ?? 0,
          limit: AGENT_EVENT_LIMITS.page + 1,
        },
      );
      const events: AgentEventView[] = [];
      let unreadable = 0;
      const page = rows.slice(0, AGENT_EVENT_LIMITS.page);
      const last = page.at(-1);
      for (const row of page) {
        const view = viewOf(row);
        if (view) events.push(view);
        else unreadable += 1;
      }
      // Left out, never half-shown; said once per page, with a count and no card text.
      if (unreadable > 0) deps.logger.warn("agent_events_unreadable", { count: unreadable });
      return {
        events,
        more: rows.length > AGENT_EVENT_LIMITS.page,
        next: last ? { at: last.at, id: last.id } : null,
      };
    },

    /** The newest card says `failed` and the owner has not read the thread since (the rail's red dot, M11R62). */
    failedCard(ownerId: string, agentId: string): boolean {
      const row = db.get<{ data: string; unread: number }>(
        `SELECT e.data AS data, a.unread AS unread FROM agent_events e JOIN agents a ON a.id = e.agent_id
         WHERE e.agent_id = $agentId AND e.owner_id = $ownerId ORDER BY e.id DESC LIMIT 1`,
        { agentId, ownerId },
      );
      if (!row || row.unread < 1) return false;
      try {
        return (JSON.parse(row.data) as { state?: unknown }).state === "failed";
      } catch {
        deps.logger.warn("agent_events_unreadable", { count: 1 });
        return false;
      }
    },
  };
}
export type AgentEvents = ReturnType<typeof createAgentEvents>;
