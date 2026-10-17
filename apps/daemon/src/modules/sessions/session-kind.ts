import { type SessionFacts, type SessionType, sessionTypeOf } from "@pap/contracts";
import type { PolicyPort } from "../policy/index.ts";
import type { SessionRow } from "./store.ts";

/** What the daemon knows of a session beyond its row, and where it reads it (M11R36). */
export interface KindDeps {
  readonly policy: Pick<PolicyPort, "sessionPolicy">;
  /** The row's folder is inside one of the owner's lane worktrees; none: no session is a lane session. */
  readonly inLane?: ((ownerId: string, cwd: string) => boolean) | undefined;
}

/** Who a session is to the daemon: read from its own records at a worker's start and again at every platform call. */
export interface SessionKind {
  readonly ownerId: string;
  readonly type: SessionType;
  readonly tainted: boolean;
  readonly agentId: string | null;
  readonly agentRole: "thread" | "task" | "child" | null;
  readonly parentSessionId: string | null;
}

type PolicyView = ReturnType<KindDeps["policy"]["sessionPolicy"]>;

function factsOf(row: SessionRow, deps: KindDeps, policy: PolicyView): SessionFacts {
  return {
    parentSessionId: row.parentSessionId ?? null,
    agentRole: row.agentRole ?? null,
    // A new task session's policy is in memory until its row is stored (M10R31).
    automationTask: row.task !== undefined || policy.toolAllowlist !== null,
    inLane: deps.inLane?.(row.ownerId, row.cwd) ?? false,
  };
}

export const kindFacts = (row: SessionRow, deps: KindDeps): SessionFacts =>
  factsOf(row, deps, deps.policy.sessionPolicy(row.ownerId, row.id));

export function sessionKind(row: SessionRow, deps: KindDeps): SessionKind {
  const policy = deps.policy.sessionPolicy(row.ownerId, row.id);
  const facts = factsOf(row, deps, policy);
  return {
    ownerId: row.ownerId,
    type: sessionTypeOf(facts),
    tainted: policy.taint.tainted,
    agentId: row.agentId ?? null,
    agentRole: facts.agentRole,
    parentSessionId: facts.parentSessionId,
  };
}
