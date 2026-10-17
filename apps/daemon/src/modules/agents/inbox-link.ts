import type { Logger } from "../../kernel/logger.ts";
import type { Inbox } from "../inbox/index.ts";
import type { AgentLinks } from "./links.ts";

/** The Inbox half of the agents' links: a reset closes the agent's reply item, a delete drops every item it carries. */
export function createInboxLink(
  items: Pick<Inbox["agentItems"], "resolveRef" | "removeAgentItems">,
  logger: Logger,
): NonNullable<AgentLinks["inbox"]> {
  return {
    clearReply: (ownerId, agentId) => void items.resolveRef(ownerId, "agent_reply", agentId, null),
    removeAgentItems(ownerId, agentId) {
      try {
        items.removeAgentItems(ownerId, agentId);
      } catch (error) {
        logger.warn("agent_items_remove_failed", { err: error });
      }
    },
  };
}
