import { randomUUID } from "node:crypto";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { type PlatformHandler, PlatformRefusal } from "../platform/index.ts";
import type { AgentEvents } from "./events.ts";
import { cleanText, type RequestItems } from "./requests.ts";

/** Notifications one agent may send an hour (M11R100). */
export const NOTIFICATIONS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
/** The Inbox item's `detail` column and the card hold at most this much (INBOX_DETAIL_CHARS). */
const NOTIFY_UNITS = 500;

export interface NotifyDeps {
  readonly events: Pick<AgentEvents, "notify">;
  /** The Inbox's agent-items port (M11R91). */
  readonly items: Pick<RequestItems, "upsertAgentItem">;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Pick<Logger, "warn">;
}

/**
 * `agent.notify` (M11R100): an Inbox `agent_notify` item (info) and a `notify` card in the agent's thread, both with the
 * agent's own words, stripped to one line and clipped to 500. 30 an hour per agent, a fixed window on the kernel Clock.
 * The result's `itemId` is the item's `ref_id`, which the card carries too.
 */
export function createNotify(deps: NotifyDeps): PlatformHandler<"agent.notify"> {
  const windows = new Map<string, { startedAt: number; used: number }>();
  /** One slot back: the call was refused after it was admitted (the agent is not the owner's), so it must not count. */
  const refund = (agentId: string): void => {
    const window = windows.get(agentId);
    if (window && window.used > 0) window.used--;
  };
  const admit = (agentId: string): boolean => {
    const now = deps.clock.now();
    for (const [id, window] of windows) if (now - window.startedAt >= HOUR_MS) windows.delete(id);
    const window = windows.get(agentId) ?? { startedAt: now, used: 0 };
    windows.set(agentId, window);
    if (window.used >= NOTIFICATIONS_PER_HOUR) return false;
    window.used++;
    return true;
  };
  return (args, ctx) => {
    if (ctx.agentId === null) return Promise.reject(new PlatformRefusal("not_found"));
    const text = cleanText(args.text, NOTIFY_UNITS);
    if (text === null) return Promise.reject(new PlatformRefusal("bad_request"));
    if (!admit(ctx.agentId)) return Promise.reject(new PlatformRefusal("rate_limited"));
    const itemId = randomUUID();
    // The card first: it is what the thread shows, and it says whether the agent is still the owner's.
    if (!deps.events.notify(ctx.ownerId, ctx.agentId, { text, itemId })) {
      refund(ctx.agentId);
      return Promise.reject(new PlatformRefusal("not_found"));
    }
    const written = deps.items.upsertAgentItem({
      ownerId: ctx.ownerId,
      kind: "agent_notify",
      agentId: ctx.agentId,
      refId: itemId,
      detail: text,
      toHandle: false,
    });
    // An info item past the Inbox's cap is skipped (M10's rule); the card still shows the notification.
    if (!written) deps.logger.warn("agent_notify_item_skipped", { agentId: ctx.agentId });
    return Promise.resolve({ itemId });
  };
}
