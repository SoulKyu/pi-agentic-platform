import { CLAUDE_BRIDGE_PROVIDER } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";

/** A run ends within 48 h of its start: this lower bound on `started_at` keeps the owner's index usable (as `agentSpentToday`). */
const MAX_RUN_SPAN_MS = 172_800_000;

export interface BoxSpend {
  /**
   * What the owner's runs cost since `fromMs` (running now, or ended since): per agent by `runs.agent_id`, else per project
   * by the session's `project_id`. `totalUsd` counts every run of the window, the ones with neither link included.
   * `apiOnly` is a member's budget-line measure: `api` and `unknown` billing, never the Claude bridge. `subscription` is
   * true when a counted run is billed `subscription`; `subscriptionAgents` and `subscriptionProjects` name the boxes with
   * such a run (the per-card "API-equivalent" mark).
   */
  todayByBox(
    ownerId: string,
    fromMs: number,
    apiOnly: boolean,
  ): {
    agents: ReadonlyMap<string, number>;
    projects: ReadonlyMap<string, number>;
    totalUsd: number;
    subscription: boolean;
    subscriptionAgents: ReadonlySet<string>;
    subscriptionProjects: ReadonlySet<string>;
  };
  /** Session id to the start of its running run: what is live now. */
  liveRuns(ownerId: string): ReadonlyMap<string, number>;
}

interface Group {
  agent_id: string | null;
  project_id: string | null;
  usd: number;
  subscription: number;
}

export function createBoxSpend(deps: { readonly db: Db; readonly clock: Pick<Clock, "now"> }): BoxSpend {
  const { db, clock } = deps;
  return {
    todayByBox(ownerId, fromMs, apiOnly) {
      const groups = db.all<Group>(
        `SELECT r.agent_id AS agent_id, s.project_id AS project_id, COALESCE(SUM(r.cost_usd), 0) AS usd,
                COALESCE(MAX(r.billing = 'subscription'), 0) AS subscription
         FROM runs r LEFT JOIN sessions s ON s.id = r.session_id
         WHERE r.owner_id = $ownerId AND r.started_at >= $from - ${MAX_RUN_SPAN_MS}
           AND (r.status = 'running' OR r.ended_at >= $from)
           ${apiOnly ? "AND r.billing IN ('api', 'unknown') AND COALESCE(r.provider, '') <> $bridge" : ""}
         GROUP BY r.agent_id, s.project_id`,
        { ownerId, from: fromMs, ...(apiOnly ? { bridge: CLAUDE_BRIDGE_PROVIDER } : {}) },
      );
      const agents = new Map<string, number>();
      const projects = new Map<string, number>();
      let totalUsd = 0;
      let subscription = false;
      const subscriptionAgents = new Set<string>();
      const subscriptionProjects = new Set<string>();
      for (const group of groups) {
        totalUsd += group.usd;
        subscription ||= group.subscription === 1;
        if (group.agent_id !== null) {
          agents.set(group.agent_id, (agents.get(group.agent_id) ?? 0) + group.usd);
          if (group.subscription === 1) subscriptionAgents.add(group.agent_id);
        } else if (group.project_id !== null) {
          projects.set(group.project_id, (projects.get(group.project_id) ?? 0) + group.usd);
          if (group.subscription === 1) subscriptionProjects.add(group.project_id);
        }
      }
      return { agents, projects, totalUsd, subscription, subscriptionAgents, subscriptionProjects };
    },
    liveRuns(ownerId) {
      const rows = db.all<{ session_id: string; started_at: number }>(
        `SELECT session_id, MAX(started_at) AS started_at FROM runs
         WHERE owner_id = $ownerId AND status = 'running' AND started_at >= $from GROUP BY session_id`,
        { ownerId, from: clock.now() - MAX_RUN_SPAN_MS },
      );
      return new Map(rows.map((row) => [row.session_id, row.started_at]));
    },
  };
}
