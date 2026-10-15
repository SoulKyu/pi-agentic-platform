import type { TaskView } from "@pap/contracts";
import type { PolicyPort } from "../policy/index.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { detailOf, isTerminal, type TaskJoined } from "./tasks.ts";

export interface TaskViewDeps {
  readonly sessions: Pick<SessionsAutomationPort, "state">;
  readonly runs: Pick<RunsPort, "sessionCost" | "limitResetAt">;
  readonly policy: Pick<PolicyPort, "sessionPolicy">;
}

/** A stored row as the board shows it: the live parts (a waiting question, the cost, the tool list) are read now. */
export function createTaskViews(deps: TaskViewDeps) {
  return function viewOf(row: TaskJoined): TaskView {
    const sessionId = row.session_id;
    const live = sessionId === null ? null : deps.sessions.state(row.owner_id, sessionId);
    const policy = sessionId === null ? null : deps.policy.sessionPolicy(row.owner_id, sessionId);
    return {
      id: row.id,
      triggerId: row.trigger_id,
      triggerName: row.trigger_name ?? row.title,
      projectId: row.project_id,
      state: row.state,
      reason: row.reason,
      origin: row.origin,
      title: row.title,
      // Stored clipped already; clipped again here so a row an older build wrote cannot reach a client unclipped.
      detail: detailOf(row.detail),
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      sessionId,
      needsInput: live?.needsInput ?? false,
      costUsd: sessionId === null ? 0 : (deps.runs.sessionCost(sessionId) ?? 0),
      // Read from the run that hit the quota (persisted), so a restart loses nothing.
      resetAt: row.state === "limited" && sessionId !== null ? deps.runs.limitResetAt(sessionId) : null,
      toolsReleased:
        isTerminal(row.state) && policy !== null && policy.recorded && policy.toolAllowlist === null,
    };
  };
}
export type TaskViews = ReturnType<typeof createTaskViews>;
