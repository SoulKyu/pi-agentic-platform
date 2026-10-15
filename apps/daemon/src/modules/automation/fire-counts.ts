import { FIRE_VERDICTS } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

/** The journal's sources (the `trigger_fires.source` values): the four trigger kinds and a task retry. */
export const FIRE_SOURCES = ["schedule", "webhook", "feed", "manual", "retry"] as const;

const counts = new WeakMap<Db, Map<string, number>>();

/**
 * Counts one journal event for `pap_trigger_fires_total` (M10R96): in process, from 0 at the daemon's start, because the
 * journal's own rows are cut at 500 per trigger and a collapsed row stands for many events, so row counts would go back.
 * Called once per event, collapsed or not; a source or verdict outside the closed sets is never a label.
 */
export function countFire(db: Db, source: string, verdict: string): void {
  if (!(FIRE_SOURCES as readonly string[]).includes(source)) return;
  if (!(FIRE_VERDICTS as readonly string[]).includes(verdict)) return;
  const byKey = counts.get(db) ?? new Map<string, number>();
  counts.set(db, byKey);
  const key = `${source}\u0000${verdict}`;
  byKey.set(key, (byKey.get(key) ?? 0) + 1);
}

export function fireSamples(db: Db): { labels: { source: string; verdict: string }; value: number }[] {
  return [...(counts.get(db) ?? [])].map(([key, value]) => {
    const [source = "", verdict = ""] = key.split("\u0000");
    return { labels: { source, verdict }, value };
  });
}
