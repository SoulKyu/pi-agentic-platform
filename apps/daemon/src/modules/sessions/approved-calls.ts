import { PLATFORM_OPS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

/** How many answers wait to be spent; the oldest is dropped past this (an absent answer only refuses a call). */
export const MAX_APPROVED_CALLS = 4_096;
/** An answer is good for this long after the owner gave it. */
export const APPROVAL_TTL_MS = 10 * 60_000;

const PLATFORM_TOOLS: ReadonlySet<string> = new Set(Object.values(PLATFORM_OPS).map((spec) => spec.tool));

/** The tool name of a platform op (`agent_delegate`, not `agent.delegate`): what its approval card carries. */
export const isPlatformTool = (tool: string): boolean => PLATFORM_TOOLS.has(tool);

/**
 * The owner's own "Allow once" answers on the cards of platform tools (M11R39, red-team RT-05). The sessions module
 * notes one only when a browser session answered and only for the tool its daemon-held card named; the dispatcher
 * spends it once, for that tool and that tool call. The map is filled by the owner's browser alone.
 */
export interface ApprovedCalls {
  note(sessionId: string, toolCallId: string, tool: string): void;
  take(sessionId: string, toolCallId: string, tool: string): boolean;
}

export function createApprovedCalls(deps: { readonly clock: Clock }): ApprovedCalls {
  const entries = new Map<string, { readonly tool: string; readonly at: number }>();
  // JSON, not a separator: a tool call id is the worker's text and could hold any character.
  const keyOf = (sessionId: string, toolCallId: string): string => JSON.stringify([sessionId, toolCallId]);
  const expired = (at: number): boolean => deps.clock.now() - at >= APPROVAL_TTL_MS;
  return {
    note(sessionId, toolCallId, tool) {
      const key = keyOf(sessionId, toolCallId);
      entries.delete(key);
      // Oldest first: every entry is inserted last, so the expired ones sit at the front.
      for (const [oldKey, entry] of entries) {
        if (!expired(entry.at) && entries.size < MAX_APPROVED_CALLS) break;
        entries.delete(oldKey);
      }
      entries.set(key, { tool, at: deps.clock.now() });
    },
    take(sessionId, toolCallId, tool) {
      const key = keyOf(sessionId, toolCallId);
      const entry = entries.get(key);
      if (!entry) return false;
      if (expired(entry.at)) {
        entries.delete(key);
        return false;
      }
      if (entry.tool !== tool) return false;
      entries.delete(key);
      return true;
    },
  };
}
