import type { SessionView } from "../../stores/session-reducer.ts";

export interface ContextMeter {
  /** The tokens the last reply reported; may exceed `window`. */
  readonly used: number;
  readonly window: number;
  /** At 80 % of the window or more. */
  readonly soon: boolean;
}

/**
 * UX1-R8: the newest reply with a usable usage, against the model's window. Hidden, never guessed: with no worker (no
 * loadout), no window, no such reply, or a compaction or branch summary newer than it (Pi itself distrusts usage taken
 * before a compaction).
 */
export function meterOf(view: SessionView): ContextMeter | null {
  const window = view.loadout?.model?.contextWindow;
  if (window === undefined || window <= 0) return null;
  for (const message of view.messages.toReversed()) {
    if (message.role === "compactionSummary" || message.role === "branchSummary") return null;
    if (message.contextTokens !== undefined)
      return { used: message.contextTokens, window, soon: message.contextTokens * 5 >= window * 4 };
  }
  return null;
}

export interface CostLine {
  readonly session: number;
  /** The session's own open run so far; null between runs. */
  readonly run: number | null;
  /** A subscription pays for it: the figures are what the API would have charged (UX1-R9). */
  readonly apiEquivalent: boolean;
}

export function costLineOf(view: SessionView): CostLine | null {
  const cost = view.cost;
  if (!cost) return null;
  return {
    session: cost.sessionUsd,
    run: cost.runUsd,
    apiEquivalent: cost.billing === "subscription" || view.loadout?.billing === "subscription",
  };
}
