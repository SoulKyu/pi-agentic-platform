import { PapError, type Caller, type PushTarget } from "@pap/contracts";
import type { Db } from "../../../kernel/db/database.ts";
import { requireBrowser } from "../service.ts";
import { loadEvent, type EventRow } from "./events.ts";

export type OpenPush = (caller: Caller, id: string) => Promise<{ target: PushTarget }>;

const BUDGET_AGENT = /^agent:([^:]+):\d{4}-\d{2}-\d{2}$/;

/** Where the click of an event lands, from the event's own ref; null for a kind of ref this daemon does not know. */
function targetOf(event: EventRow): PushTarget | null {
  switch (event.refKind) {
    case "session":
      return { kind: "session", id: event.refId };
    case "inbox":
      return { kind: "inbox", id: event.refId };
    case "budget": {
      const agentId = BUDGET_AGENT.exec(event.refId)?.[1];
      return agentId === undefined ? { kind: "settings", id: "automation" } : { kind: "agent", id: agentId };
    }
    case "digest":
      return { kind: "inbox", id: null };
    case "test":
      return { kind: "settings", id: "notifications" };
    default:
      return null;
  }
}

/**
 * `push.open` (M12R33): the click of a notification asks what its id is about. Only the caller's own events resolve; another
 * owner's id and an unknown id are the same `not_found`, so the id tells nothing. A settled event still resolves: the page it
 * opens says whether the thing was handled. Browser only (M12R10). The answer is a place, never content.
 */
export function createOpenPush(deps: { readonly db: Db }): OpenPush {
  return async (caller, id) => {
    requireBrowser(caller);
    const event = loadEvent(deps.db, id);
    const target = event === undefined || event.ownerId !== caller.userId ? null : targetOf(event);
    if (target === null) throw new PapError("not_found");
    return { target };
  };
}
