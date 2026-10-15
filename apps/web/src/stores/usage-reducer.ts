import { type LimitView, USAGE_MAX_LIMITS, UsageStreamEvent } from "@pap/contracts";

export interface UsageView {
  readonly loaded: boolean;
  /** Why the server refused the `usage` subscription; null once a snapshot came. */
  readonly failed: string | null;
  /** The sessions whose latest run hit the provider's quota, oldest first (a Map keeps insertion order). */
  readonly limits: ReadonlyMap<string, LimitView>;
  readonly todayUsd: number;
  readonly budgetUsd: number | null;
  readonly autoResume: boolean;
}

export const EMPTY_USAGE: UsageView = {
  loaded: false,
  failed: null,
  limits: new Map(),
  todayUsd: 0,
  budgetUsd: null,
  autoResume: true,
};

/** The newest limits win: a screen cannot hold more than the snapshot can carry. */
function bounded(limits: Map<string, LimitView>): Map<string, LimitView> {
  for (const key of limits.keys()) {
    if (limits.size <= USAGE_MAX_LIMITS) break;
    limits.delete(key);
  }
  return limits;
}

export function reduceUsage(view: UsageView, raw: unknown): UsageView {
  const parsed = UsageStreamEvent.safeParse(raw);
  if (!parsed.success) return view;
  const event = parsed.data;
  switch (event.kind) {
    case "snapshot":
      return {
        loaded: true,
        failed: null,
        limits: new Map(event.limits.map((limit) => [limit.sessionId, limit])),
        todayUsd: event.todayUsd,
        budgetUsd: event.budgetUsd,
        autoResume: event.autoResume,
      };
    case "limit": {
      const limits = new Map(view.limits);
      // Replaced, not updated in place: a limit that changed moves to the newest end.
      limits.delete(event.limit.sessionId);
      limits.set(event.limit.sessionId, event.limit);
      return { ...view, limits: bounded(limits) };
    }
    case "limit_cleared": {
      if (!view.limits.has(event.sessionId)) return view;
      const limits = new Map(view.limits);
      limits.delete(event.sessionId);
      return { ...view, limits };
    }
    case "spend":
      return { ...view, todayUsd: event.todayUsd, budgetUsd: event.budgetUsd };
  }
}

export const failUsage = (view: UsageView, code: string): UsageView => ({ ...view, failed: code });
