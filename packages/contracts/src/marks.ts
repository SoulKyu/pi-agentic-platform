import { z } from "zod";

/** Pinned sessions per owner (M4R15). */
export const MAX_PINS = 50;
/** A snooze ends at least a minute and at most 366 days from now. */
export const SNOOZE_MIN_MS = 60_000;
export const SNOOZE_MAX_MS = 366 * 86_400_000;

const Id = z.string().min(1).max(128);
const Millis = z.number().int().min(0).max(8.64e15);

/** How a session stood before a change, so Undo can put it back, its place among the pins included (T3). */
export const MarkState = z.object({
  pinned: z.boolean(),
  /** The pinned session it stood before; null when it was the last pin or not pinned. */
  pinBefore: Id.nullable(),
  archived: z.boolean(),
  settled: z.boolean(),
  snoozedUntil: Millis.nullable(),
});
export type MarkState = z.infer<typeof MarkState>;

export const MarkChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pin"), before: Id.nullable() }),
  z.object({ kind: z.literal("unpin") }),
  z.object({ kind: z.literal("archive") }),
  z.object({ kind: z.literal("unarchive") }),
  z.object({ kind: z.literal("settle") }),
  z.object({ kind: z.literal("unsettle") }),
  z.object({ kind: z.literal("snooze"), until: Millis }),
  z.object({ kind: z.literal("wake") }),
  z.object({ kind: z.literal("restore"), state: MarkState }),
]);
export type MarkChange = z.infer<typeof MarkChange>;

/** How the sidebar files a session, as the sessions table keeps it. */
export interface Marks {
  readonly pinRank: number | null;
  readonly archivedAt: number | null;
  readonly settledAt: number | null;
  /** Settled by the 3-day rule rather than by the person. */
  readonly settledAuto: boolean;
  /** When the person last un-settled it; the 3-day rule counts from here too. */
  readonly unsettledAt: number | null;
  readonly snoozedUntil: number | null;
}

export const NO_MARKS: Marks = {
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  settledAuto: false,
  unsettledAt: null,
  snoozedUntil: null,
};

export type MarkOutcome =
  | {
      readonly ok: true;
      readonly marks: Marks;
      /** The owner's pins after the change, first first; null when their order did not change. */
      readonly pins: readonly string[] | null;
    }
  | { readonly ok: false; readonly code: "bad_request" | "limit_reached" };

const without = (pins: readonly string[], id: string): string[] => pins.filter((pin) => pin !== id);

/** `id` among the pins, before `before`; last when `before` is null, unknown or `id` itself. */
function pinnedBefore(pins: readonly string[], id: string, before: string | null): string[] {
  const rest = without(pins, id);
  const at = before === null || before === id ? -1 : rest.indexOf(before);
  return at === -1 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)];
}

const rankIn = (pins: readonly string[], id: string): number | null => {
  const at = pins.indexOf(id);
  return at === -1 ? null : at + 1;
};

const samePins = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((pin, i) => pin === b[i]);

/**
 * The marks of session `id` after `change` (M4R14, M4R15): the one rule set, used by the daemon to write and by the
 * browser to show the change before the answer. `pins` are the owner's pinned sessions, first first.
 */
export function applyMark(
  id: string,
  current: Marks,
  change: MarkChange,
  pins: readonly string[],
  now: number,
): MarkOutcome {
  const unpinned = (marks: Marks): MarkOutcome => {
    const next = without(pins, id);
    return { ok: true, marks: { ...marks, pinRank: null }, pins: next.length === pins.length ? null : next };
  };
  const full = (pinned: boolean) => pinned && !pins.includes(id) && pins.length >= MAX_PINS;
  switch (change.kind) {
    case "pin": {
      if (full(true)) return { ok: false, code: "limit_reached" };
      const next = pinnedBefore(pins, id, change.before);
      // A pinned session is one the person keeps in view: no longer archived or settled.
      const marks = {
        ...current,
        pinRank: rankIn(next, id),
        archivedAt: null,
        settledAt: null,
        settledAuto: false,
      };
      return { ok: true, marks, pins: next };
    }
    case "unpin":
      return unpinned(current);
    case "archive":
      return unpinned({ ...current, archivedAt: current.archivedAt ?? now, snoozedUntil: null });
    case "unarchive":
      return { ok: true, marks: { ...current, archivedAt: null }, pins: null };
    case "settle":
      return unpinned({
        ...current,
        settledAt: current.settledAt ?? now,
        settledAuto: false,
        snoozedUntil: null,
      });
    case "unsettle":
      return {
        ok: true,
        marks: { ...current, settledAt: null, settledAuto: false, unsettledAt: now },
        pins: null,
      };
    case "snooze": {
      const early = change.until < now + SNOOZE_MIN_MS;
      const late = change.until > now + SNOOZE_MAX_MS;
      if (current.archivedAt !== null || early || late) return { ok: false, code: "bad_request" };
      const marks = { ...current, snoozedUntil: change.until, settledAt: null, settledAuto: false };
      return { ok: true, marks, pins: null };
    }
    case "wake":
      return { ok: true, marks: { ...current, snoozedUntil: null }, pins: null };
    case "restore": {
      const { state } = change;
      if (full(state.pinned)) return { ok: false, code: "limit_reached" };
      const after = state.pinned ? pinnedBefore(pins, id, state.pinBefore) : without(pins, id);
      const marks: Marks = {
        pinRank: rankIn(after, id),
        archivedAt: state.archived ? (current.archivedAt ?? now) : null,
        settledAt: state.settled ? (current.settledAt ?? now) : null,
        settledAuto: state.settled ? current.settledAuto : false,
        unsettledAt: current.unsettledAt,
        snoozedUntil: state.snoozedUntil !== null && state.snoozedUntil > now ? state.snoozedUntil : null,
      };
      return { ok: true, marks, pins: samePins(after, pins) ? null : after };
    }
  }
}

/** What Undo sends back to restore session `id` as it stands now. */
export function markStateOf(id: string, marks: Marks, pins: readonly string[], now: number): MarkState {
  const at = pins.indexOf(id);
  return {
    pinned: at !== -1,
    pinBefore: at === -1 ? null : (pins[at + 1] ?? null),
    archived: marks.archivedAt !== null,
    settled: marks.settledAt !== null,
    snoozedUntil: isSnoozed(marks, now) ? marks.snoozedUntil : null,
  };
}

/** A snooze ends when its time comes; the browser does not wait for the daemon's timer to show that. */
export const isSnoozed = (marks: Pick<Marks, "snoozedUntil">, now: number): boolean =>
  marks.snoozedUntil !== null && marks.snoozedUntil > now;
