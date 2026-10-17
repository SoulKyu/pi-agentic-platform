import { AGENT_EVENT_LIMITS } from "@pap/contracts";
import { stripHidden } from "./untrusted-text.ts";

export interface HandOff {
  readonly agentId: string;
  readonly name: string;
  readonly prompt: string;
}

/**
 * `@<Name> text` at the very start of a message, for another agent's exact name (case included) and a non-empty text
 * (M11R123). Anything else is a normal message: `@` elsewhere keeps M8's file mentions.
 */
export function parseHandOff(
  message: string,
  ownAgentId: string,
  agents: readonly { readonly id: string; readonly name: string }[],
): HandOff | null {
  if (!message.startsWith("@")) return null;
  let best: HandOff | null = null;
  for (const agent of agents) {
    if (agent.id === ownAgentId) continue;
    const head = `@${agent.name}`;
    if (!message.startsWith(head) || !/^\s/.test(message.slice(head.length))) continue;
    const prompt = message.slice(head.length).trim();
    // Names may hold a blank: the longest exact name wins, whatever the list order.
    if (prompt !== "" && (best === null || agent.name.length > best.name.length))
      best = { agentId: agent.id, name: agent.name, prompt };
  }
  return best;
}

/** The newest assistant message with text, hidden characters removed and clipped to what a queued prompt may carry. */
export function lastAssistantQuote(
  messages: readonly { readonly role: string; readonly text: string }[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const quote = stripHidden(message.text).slice(0, AGENT_EVENT_LIMITS.queuePrompt);
    if (quote.trim() !== "") return quote;
  }
  return undefined;
}
