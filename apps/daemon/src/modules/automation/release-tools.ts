import { type Caller, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { AuditPort } from "../audit/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { isTerminal, type TaskRow, type TaskStore } from "./tasks.ts";

export interface ReleaseToolsDeps {
  readonly store: Pick<TaskStore, "getOwned" | "bySession">;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
  readonly policy: Pick<PolicyPort, "clearTaskPolicy" | "sessionPolicy">;
  readonly sessions: Pick<SessionsAutomationPort, "releaseIdle" | "state">;
  /** The auth module's password step-up: throws `step_up_required`. */
  requireStepUp(caller: Caller, now: number): void;
  /** Tells the board the task's `toolsReleased` changed. */
  announce(row: TaskRow): void;
}

/** By task while its row exists, by session once the 30-day rule removed the row (M10R153). */
export type ReleaseTarget = { readonly taskId: string } | { readonly sessionId: string };

/**
 * "Use my normal tools" (M10R153, owner m10a7): a finished task's session stops carrying the trigger's tool list.
 * Owner only (`automation:admin`), with the password step-up, audited. The worker goes first: a busy one changes
 * nothing, and a worker started afterwards reads the lifted list. A session whose task row is gone is found by the
 * session itself: it must exist, be the caller's and still carry a task tool list, else `not_found`.
 */
export function createReleaseTools(deps: ReleaseToolsDeps) {
  /** The session to lift and the task row that still describes it, if any. */
  function resolve(caller: Caller, target: ReleaseTarget): { sessionId: string; row: TaskRow | null } {
    const owner = caller.userId;
    const byTask = "taskId" in target ? deps.store.getOwned(owner, target.taskId) : undefined;
    if ("taskId" in target && !byTask) throw new PapError("not_found");
    const row = byTask ?? ("sessionId" in target ? deps.store.bySession(target.sessionId) : undefined);
    if (row) {
      if (row.owner_id !== owner) throw new PapError("not_found");
      if (!isTerminal(row.state)) throw new PapError("session_busy");
      if (row.session_id === null) throw new PapError("not_found");
      return { sessionId: row.session_id, row };
    }
    const sessionId = (target as { sessionId: string }).sessionId;
    const policy = deps.policy.sessionPolicy(owner, sessionId);
    if (deps.sessions.state(owner, sessionId) === null || !policy.recorded || policy.toolAllowlist === null)
      throw new PapError("not_found");
    return { sessionId, row: null };
  }

  return async function releaseTools(
    caller: Caller,
    target: ReleaseTarget,
  ): Promise<{ taskId: string | null; sessionId: string }> {
    deps.requireStepUp(caller, deps.clock.now());
    const { sessionId, row } = resolve(caller, target);
    const outcome = deps.sessions.releaseIdle(caller.userId, sessionId);
    if (outcome === "busy") throw new PapError("session_busy");
    // Still unattended (the task's end did not reach it): the policy module answers session_busy and changes nothing.
    deps.policy.clearTaskPolicy(caller.userId, sessionId);
    deps.audit.append({
      ownerId: caller.userId,
      actor: caller.kind === "token" ? "token" : "user",
      actorId: caller.credentialId.slice(0, 128),
      kind: "policy",
      reason: "automation task tools released",
      detail: row ? { taskId: row.id } : { sessionId },
    });
    if (row) deps.announce(row);
    return { taskId: row?.id ?? null, sessionId };
  };
}
export type ReleaseTools = ReturnType<typeof createReleaseTools>;
