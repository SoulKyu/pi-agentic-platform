import type { Clock } from "../../kernel/clock.ts";
import { cutUnits, LONE_SURROGATE } from "../../kernel/text.ts";
import { type PlatformHandler, PlatformRefusal } from "../platform/index.ts";
import type { LanesStore } from "./store.ts";

/** The longest note kept, and notes one lane takes an hour (M11R41). */
export const NOTE_CHARS = 2000;
export const NOTES_PER_HOUR = 60;
const HOUR_MS = 3_600_000;

// Control characters except tab and new line, then format, line and paragraph separators (bidi, zero-width, U+2028/9).
const HIDDEN = /(?![\t\n])\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/gu;

/** What the model wrote, as the text kept: hidden characters gone, trimmed, clipped; "" when nothing visible is left. */
// Clipped to 2 000 UTF-16 units (the SQL CHECK and LaneView limit), never between the halves of a surrogate pair.
export const cleanNote = (raw: string): string =>
  cutUnits(raw.replace(LONE_SURROGATE, "�").replace(HIDDEN, "").trim(), NOTE_CHARS).trimEnd();

export interface LaneNoteDeps {
  readonly store: Pick<LanesStore, "open" | "setNote">;
  /** The sessions module's records: the owner's sessions whose folder is in a lane's worktree. */
  readonly sessions: { sessionIdsIn(ownerId: string, folder: string): string[] };
  readonly clock: Clock;
  /** The lane stream: the lane's view goes out with the note. */
  publish(laneId: string): void;
  /** The per-lane hour windows; tests pass their own to see them evicted. */
  readonly windows?: Map<string, { startedAt: number; used: number }>;
}

/**
 * `lane.note` (M11R41): the one-line status of the lane the calling session works in. The lane is found from the
 * owner's open lanes and the sessions in their folders, so another owner's lane and an archived one are `not_found`.
 * Model text: stored without hidden characters, shown as text, 60 an hour per lane (fixed hour window on the kernel Clock).
 */
export function createLaneNote(deps: LaneNoteDeps): PlatformHandler<"lane.note"> {
  const windows = deps.windows ?? new Map<string, { startedAt: number; used: number }>();
  const admit = (laneId: string): boolean => {
    const now = deps.clock.now();
    for (const [id, window] of windows) if (now - window.startedAt >= HOUR_MS) windows.delete(id);
    const window = windows.get(laneId) ?? { startedAt: now, used: 0 };
    windows.set(laneId, window);
    if (window.used >= NOTES_PER_HOUR) return false;
    window.used++;
    return true;
  };
  return (args, ctx) => {
    const lane = deps.store
      .open(ctx.ownerId)
      .find((row) => deps.sessions.sessionIdsIn(ctx.ownerId, row.worktree).includes(ctx.sessionId));
    if (!lane) return Promise.reject(new PlatformRefusal("not_found"));
    if (!admit(lane.id)) return Promise.reject(new PlatformRefusal("rate_limited"));
    const note = cleanNote(args.note);
    deps.store.setNote(lane.id, note === "" ? null : note, note === "" ? null : deps.clock.now());
    deps.publish(lane.id);
    return Promise.resolve({});
  };
}
