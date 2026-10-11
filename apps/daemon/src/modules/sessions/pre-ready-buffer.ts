import type { SessionStreamEvent } from "@pap/contracts";
import { sizeOf } from "./snapshot.ts";

/** How many events, and how many bytes of them, a new session holds back until its row is stored. */
export const MAX_PRE_READY_EVENTS = 32;
export const MAX_PRE_READY_BYTES = 256 * 1024;

/** One thing the worker did before it was ready: an event for the stream, or a line for the journal. */
export type PreReadyItem =
  | { readonly kind: "publish"; readonly event: SessionStreamEvent }
  | { readonly kind: "record"; readonly recordKind: string; readonly data: unknown };

export interface PreReadyBuffer {
  add(item: PreReadyItem): void;
  /** What was kept, in order, and how many items did not fit. */
  drain(): { readonly items: readonly PreReadyItem[]; readonly dropped: number };
}

/**
 * A new session has no row until its worker is ready (a failed start leaves no trace, R93), so what the worker says
 * meanwhile (an extension failing at start-up, a policy audit line) has nowhere to go yet. The service holds it here,
 * bounded, and replays it once the row is stored. Past the bounds the earliest items stay and the rest are counted.
 */
export function createPreReadyBuffer(): PreReadyBuffer {
  const items: PreReadyItem[] = [];
  let bytes = 0;
  let dropped = 0;
  return {
    add(item) {
      const size = sizeOf(item);
      if (items.length >= MAX_PRE_READY_EVENTS || bytes + size > MAX_PRE_READY_BYTES) {
        dropped++;
        return;
      }
      items.push(item);
      bytes += size;
    },
    drain: () => ({ items, dropped }),
  };
}
