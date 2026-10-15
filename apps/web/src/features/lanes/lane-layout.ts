import { reportClientIssue } from "../../lib/report.ts";

export const LAYOUT_KEY = "pap.lane-layout.v1";
/** A cache: the least recently written lane goes first (M9R62). */
export const MAX_LAYOUTS = 200;

export const RIGHT_PANES = ["review", "changes", "terminal"] as const;
export type RightPane = (typeof RIGHT_PANES)[number];

export interface LaneLayout {
  readonly ratio: number;
  readonly right: RightPane;
  readonly split: boolean;
}

export const DEFAULT_LAYOUT: LaneLayout = { ratio: 0.5, right: "review", split: false };

type Store = Pick<Storage, "getItem" | "setItem">;
type Entry = readonly [string, LaneLayout];

function validLayout(value: unknown): LaneLayout | null {
  if (typeof value !== "object" || value === null) return null;
  const { ratio, right, split } = value as Record<string, unknown>;
  if (typeof ratio !== "number" || !(ratio > 0 && ratio < 1)) return null;
  if (!RIGHT_PANES.includes(right as RightPane) || typeof split !== "boolean") return null;
  return { ratio, right: right as RightPane, split };
}

function readAll(storage: Store): Entry[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LAYOUT_KEY) ?? "null");
    const lanes = (parsed as { v?: unknown; lanes?: unknown } | null)?.lanes;
    if ((parsed as { v?: unknown } | null)?.v !== 1 || !Array.isArray(lanes)) return [];
    const entries: Entry[] = [];
    for (const row of lanes as unknown[]) {
      const [id, layout] = Array.isArray(row) ? (row as unknown[]) : [];
      const valid = validLayout(layout);
      if (typeof id === "string" && valid) entries.push([id, valid]);
    }
    return entries.slice(-MAX_LAYOUTS);
  } catch {
    return [];
  }
}

type Listener = (laneId: string, layout: LaneLayout) => void;
const listeners = new Set<Listener>();

/** A lane tab that is already open hears `showReview` (the compare tab's View diff). Returns the unsubscribe. */
export function onShowReview(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readLayout(laneId: string, storage: Store = localStorage): LaneLayout {
  return readAll(storage).find(([id]) => id === laneId)?.[1] ?? DEFAULT_LAYOUT;
}

export function writeLayout(laneId: string, layout: LaneLayout, storage: Store = localStorage): void {
  const rest = readAll(storage).filter(([id]) => id !== laneId);
  const lanes = [...rest, [laneId, layout] as const].slice(-MAX_LAYOUTS);
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, lanes }));
  } catch {
    reportClientIssue("storage_refused");
  }
}

/** Stores the Review pane for the lane and tells a mounted lane tab to switch to it. */
export function showReview(laneId: string, storage: Store = localStorage): void {
  const layout: LaneLayout = { ...readLayout(laneId, storage), right: "review" };
  writeLayout(laneId, layout, storage);
  for (const listener of [...listeners]) listener(laneId, layout);
}
