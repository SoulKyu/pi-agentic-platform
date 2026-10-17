import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { rangeStart, startOfLocalDay } from "./days.ts";
import type { RunBilling } from "./store.ts";

/** A run ends within 48 h of its start (run deadlines are far shorter): this bound keeps `runs_agent_started` usable. */
const MAX_RUN_SPAN_MS = 172_800_000;
const TOKENS = "(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)";

export interface AgentSpend {
  /**
   * Everything the agent's runs cost today (M11R74): its thread, its tasks and its children (each run carries the agent
   * of its session). M10's day rule: a finished run counts the day it ended, a running one counts now with what its row
   * says so far (the row is saved after each message). `timeZone` null: the server's.
   */
  agentSpentToday(ownerId: string, agentId: string, timeZone: string | null): { usd: number; tokens: number };
  /** The same cost over the last 7 or 30 days, today included. */
  agentUsd(ownerId: string, agentId: string, timeZone: string | null, range: "7d" | "30d"): number;
  /** How the agent's runs are billed: `subscription` if any was, else `api` if any was, else `unknown` (also with none). */
  agentBilling(ownerId: string, agentId: string): RunBilling;
  /** What the runs of one task cost and how they were billed (a thread task shares its session with the others). */
  taskRuns(taskId: string): { usd: number; billing: RunBilling };
}

/** The agent's spend, read from the runs registry's own table: there is no second counter (M10R83). */
export function createAgentSpend(deps: { readonly db: Db; readonly clock: Pick<Clock, "now"> }): AgentSpend {
  const { db, clock } = deps;

  function since(ownerId: string, agentId: string, from: number): { usd: number; tokens: number } {
    const row = db.get<{ usd: number; tokens: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(${TOKENS}), 0) AS tokens FROM runs
       WHERE owner_id = $ownerId AND agent_id = $agentId AND started_at >= $from - ${MAX_RUN_SPAN_MS}
         AND (status = 'running' OR ended_at >= $from)`,
      { ownerId, agentId, from },
    );
    return { usd: row?.usd ?? 0, tokens: row?.tokens ?? 0 };
  }

  const billingOf = (kinds: ReadonlySet<RunBilling>): RunBilling =>
    kinds.has("subscription") ? "subscription" : kinds.has("api") ? "api" : "unknown";

  return {
    agentSpentToday: (ownerId, agentId, timeZone) =>
      since(ownerId, agentId, startOfLocalDay(clock.now(), timeZone)),
    agentUsd: (ownerId, agentId, timeZone, range) =>
      since(ownerId, agentId, rangeStart(clock.now(), range, timeZone)).usd,
    agentBilling: (ownerId, agentId) =>
      billingOf(
        new Set(
          db
            .all<{ billing: RunBilling }>(
              "SELECT DISTINCT billing FROM runs WHERE owner_id = $ownerId AND agent_id = $agentId AND status <> 'running'",
              { ownerId, agentId },
            )
            .map((row) => row.billing),
        ),
      ),
    taskRuns(taskId) {
      const rows = db.all<{ billing: RunBilling; usd: number }>(
        "SELECT billing, COALESCE(SUM(cost_usd), 0) AS usd FROM runs WHERE task_id = $taskId GROUP BY billing",
        { taskId },
      );
      return {
        usd: rows.reduce((sum, row) => sum + row.usd, 0),
        billing: billingOf(new Set(rows.map((row) => row.billing))),
      };
    },
  };
}
