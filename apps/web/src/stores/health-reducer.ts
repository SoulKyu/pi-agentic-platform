import { OpsStreamEvent, type HealthEvent } from "@pap/contracts";

export interface HealthView {
  readonly loaded: boolean;
  /** Newest first. One row per collapsed event, `seq` per daemon run. */
  readonly events: readonly HealthEvent[];
  readonly hasMore: boolean;
}

export const EMPTY_HEALTH: HealthView = { loaded: false, events: [], hasMore: false };

const bySeq = (a: HealthEvent, b: HealthEvent) => b.seq - a.seq;

/** The `ops` stream (spec §4): a snapshot replaces, an event inserts by `seq`, a collapse bumps its row. Garbage is skipped, never fatal. */
export function reduceHealth(view: HealthView, event: unknown): HealthView {
  const parsed = OpsStreamEvent.safeParse(event);
  if (!parsed.success) return view;
  switch (parsed.data.kind) {
    case "snapshot":
      return { loaded: true, events: [...parsed.data.events].sort(bySeq), hasMore: parsed.data.hasMore };
    case "event": {
      const { event } = parsed.data;
      if (view.events.some((one) => one.seq === event.seq)) return view;
      return { ...view, events: [event, ...view.events].sort(bySeq) };
    }
    case "collapse": {
      const { seq, ts, count } = parsed.data;
      if (!view.events.some((one) => one.seq === seq)) return view;
      return {
        ...view,
        events: view.events.map((one) => (one.seq === seq ? { ...one, ts, count } : one)),
      };
    }
  }
}

/** A page of `ops.events.list` (older than everything loaded): merged by `seq`, its `hasMore` wins. */
export function appendHealthPage(
  view: HealthView,
  page: { readonly events: readonly HealthEvent[]; readonly hasMore: boolean },
): HealthView {
  const seen = new Set(view.events.map((event) => event.seq));
  return {
    ...view,
    events: [...view.events, ...page.events.filter((event) => !seen.has(event.seq))].sort(bySeq),
    hasMore: page.hasMore,
  };
}
