import { MEMORY_LIMITS, type MemoryItemView, type MemoryScopeRef } from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";

/** One string per scope, for the picker's value and for telling a scope change from a reload. */
export function scopeKey(scope: MemoryScopeRef): string {
  return scope.kind === "user" ? "user" : `${scope.kind}:${scope.id}`;
}

/** The memories whose text holds the query (without case, trimmed); a blank query keeps them all. */
export function filterItems(items: readonly MemoryItemView[], query: string): MemoryItemView[] {
  const needle = query.trim().toLowerCase();
  return needle === "" ? [...items] : items.filter((item) => item.text.toLowerCase().includes(needle));
}

/** `memory.forget` takes this many ids; a bigger selection could never be sent. */
export const FORGET_MAX = MEMORY_LIMITS.forgetIds;

/** Picks or unpicks `id`; a pick past `FORGET_MAX` is refused (the set comes back unchanged). */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.delete(id)) return next;
  if (next.size < FORGET_MAX) next.add(id);
  return next;
}

/** After a reload, only the ids the list still holds stay picked. */
export function pruneSelection(selected: ReadonlySet<string>, items: readonly MemoryItemView[]): Set<string> {
  const present = new Set(items.map((item) => item.id));
  return new Set([...selected].filter((id) => present.has(id)));
}

export interface Counter {
  readonly used: number;
  readonly max: number;
  readonly over: boolean;
  readonly empty: boolean;
}

/** The correction's counter: `memory.save` accepts 1 to 4 096 characters (UTF-16 units, as the daemon counts). */
export function correctionCounter(text: string): Counter {
  return {
    used: text.length,
    max: MEMORY_LIMITS.textChars,
    over: text.length > MEMORY_LIMITS.textChars,
    empty: text.trim() === "",
  };
}

export interface DecideOutcome {
  /** pap's sentence for an answer that settles the row; null when the failure keeps it. */
  readonly key: MessageKey | null;
  readonly settled: boolean;
}

/** `conflict`: pi-mem0 is applying the fact. `not_found`: someone already handled it (or a restart lost it). */
export function decideOutcome(code: string): DecideOutcome {
  if (code === "conflict") return { key: "memory.review.applying", settled: true };
  if (code === "not_found") return { key: "memory.review.handled", settled: true };
  return { key: null, settled: false };
}
