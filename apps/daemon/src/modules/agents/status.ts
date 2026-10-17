import { type AgentStatus, type Caller, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { AgentSpend } from "../runs/index.ts";
import type { AgentEvents } from "./events.ts";
import type { AgentLinks } from "./links.ts";
import type { AgentStore } from "./store.ts";

export interface AgentReadsDeps {
  readonly store: Pick<AgentStore, "get">;
  readonly events: Pick<AgentEvents, "list">;
  readonly spend: Pick<AgentSpend, "agentSpentToday" | "agentUsd" | "agentBilling">;
  /** The automation time zone of the owner: the day the budget and the figures count in (M10's rule). */
  readonly timeZone: (ownerId: string) => string | null;
  /** Read at each call: the links are bound after the module is built. */
  readonly links: () => AgentLinks;
}

/**
 * What the owner reads of an agent's activity: the thread's cards (M11R72) and the status panel (M11R76). An agent that
 * is not the owner's is `not_found`, whatever else is asked.
 */
export function createAgentReads(deps: AgentReadsDeps) {
  const owned = (ownerId: string, agentId: string) => {
    const record = deps.store.get(ownerId, agentId);
    if (!record) throw new PapError("not_found");
    return record;
  };
  return {
    events(caller: Caller, params: ParamsOf<"agents.events">): ResultOf<"agents.events"> {
      owned(caller.userId, params.agentId);
      const page = deps.events.list(caller.userId, params.agentId, params.before);
      // Under the frame budget (M2R54): the page stops where the next card would pass it, and the cursor follows the last
      // card that is in. The cut cards are read by the next page; a page of unreadable rows still carries its cursor.
      let used = sizeOf({ events: [], more: true, next: page.next });
      const events: typeof page.events = [];
      for (const event of page.events) {
        const size = sizeOf(event) + 1;
        if (used + size > PAGE_BYTES && events.length > 0) {
          const last = events[events.length - 1];
          return { events, more: true, next: last ? { at: last.at, id: last.id } : page.next };
        }
        used += size;
        events.push(event);
      }
      return { events, more: page.more, next: page.next };
    },

    status(caller: Caller, agentId: string): AgentStatus {
      const record = owned(caller.userId, agentId);
      const ownerId = caller.userId;
      const zone = deps.timeZone(ownerId);
      const today = deps.spend.agentSpentToday(ownerId, agentId, zone);
      const budget = record.input?.budget;
      const work = deps.links().automation?.statusOf?.(caller, agentId);
      const head = {
        today: {
          usd: today.usd,
          tokens: today.tokens,
          budgetUsd: budget?.usdPerDay ?? null,
          budgetTokens: budget?.tokensPerDay ?? null,
        },
        days7Usd: deps.spend.agentUsd(ownerId, agentId, zone, "7d"),
        days30Usd: deps.spend.agentUsd(ownerId, agentId, zone, "30d"),
        billing: deps.spend.agentBilling(ownerId, agentId),
      } satisfies Omit<AgentStatus, "tasks" | "triggers" | "truncated">;
      // The same frame budget: tasks first (small), then as many triggers as fit (a prompt can be 16 000 characters).
      let used = sizeOf({ ...head, tasks: [], triggers: [], truncated: true });
      const tasks = [...(work?.tasks ?? [])];
      used += tasks.reduce((sum, task) => sum + sizeOf(task) + 1, 0);
      const triggers: AgentStatus["triggers"] = [];
      let truncated = false;
      for (const trigger of work?.triggers ?? []) {
        const size = sizeOf(trigger) + 1;
        if (used + size > PAGE_BYTES) {
          truncated = true;
          break;
        }
        used += size;
        triggers.push(trigger);
      }
      return { ...head, tasks, triggers, truncated };
    },
  };
}
export type AgentReads = ReturnType<typeof createAgentReads>;
