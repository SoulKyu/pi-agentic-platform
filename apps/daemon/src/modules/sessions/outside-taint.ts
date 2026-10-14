import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { SessionsStore } from "./store.ts";

/**
 * A write outside pap added tool results to a session's file (decision 75 Q5, M7R27): the session may now hold content
 * pap never fenced. `markTainted` takes no epoch (M7R28): a late outside write after a Clear taints again, and the
 * owner clears again, as for M5's late-result residual. Audit and log only when this call raised the taint.
 */
export function outsideToolResultsTaint(deps: {
  readonly store: Pick<SessionsStore, "get">;
  readonly policy: Pick<PolicyPort, "markTainted">;
  readonly audit: Pick<AuditPort, "append">;
  readonly logger: Logger;
}): (sessionId: string) => void {
  return (sessionId) => {
    const row = deps.store.get(sessionId);
    if (!row) return;
    if (!deps.policy.markTainted(row.ownerId, sessionId)) return;
    deps.logger.info("session_tainted_outside", { sessionId });
    deps.audit.append({
      ownerId: row.ownerId,
      actor: "system",
      kind: "policy",
      reason: "tainted_outside",
      sessionId,
    });
  };
}
