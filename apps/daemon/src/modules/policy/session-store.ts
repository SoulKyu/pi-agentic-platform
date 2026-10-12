import type { ApprovalMode } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

export interface SessionPolicyRow {
  /** NULL: the session follows the owner's default. */
  readonly approvalMode: ApprovalMode | null;
  readonly taintedAt: number | null;
  readonly taintEpoch: number;
}

// Every statement names the owner: a row of another owner is never read nor changed, whatever the session id.
export function createSessionPolicyStore(db: Db) {
  const read = (ownerId: string, sessionId: string) =>
    db.get<SessionPolicyRow>(
      "SELECT approval_mode AS approvalMode, tainted_at AS taintedAt, taint_epoch AS taintEpoch FROM session_policy WHERE session_id = $sessionId AND owner_id = $ownerId",
      { sessionId, ownerId },
    );
  return {
    get: read,
    setMode: (ownerId: string, sessionId: string, mode: ApprovalMode | null, now: number): void => {
      db.run(
        "INSERT INTO session_policy (session_id, owner_id, approval_mode, updated_at) VALUES ($sessionId, $ownerId, $mode, $now) " +
          "ON CONFLICT (session_id) DO UPDATE SET approval_mode = excluded.approval_mode, updated_at = excluded.updated_at " +
          "WHERE session_policy.owner_id = excluded.owner_id",
        { sessionId, ownerId, mode, now },
      );
    },
    /**
     * True when this call raised the taint; false when it was already up or the report is stale. `observedEpoch` is the
     * worker's taint epoch when it reported: a clear moved the stored epoch past it, so the report is ignored (M5R60).
     * Null (the audit fallback) skips that check.
     */
    markTainted: (ownerId: string, sessionId: string, observedEpoch: number | null, now: number): boolean =>
      db.run(
        "INSERT INTO session_policy (session_id, owner_id, tainted_at, updated_at) VALUES ($sessionId, $ownerId, $now, $now) " +
          "ON CONFLICT (session_id) DO UPDATE SET tainted_at = excluded.tainted_at, updated_at = excluded.updated_at " +
          "WHERE session_policy.tainted_at IS NULL AND session_policy.owner_id = excluded.owner_id " +
          "AND ($observedEpoch IS NULL OR session_policy.taint_epoch <= $observedEpoch)",
        { sessionId, ownerId, now, observedEpoch },
      ).changes > 0,
    /** Lowers the taint and adds one to the epoch, whether or not the session was tainted. */
    clearTaint: (ownerId: string, sessionId: string, now: number): void => {
      db.run(
        "INSERT INTO session_policy (session_id, owner_id, tainted_at, taint_epoch, updated_at) VALUES ($sessionId, $ownerId, NULL, 1, $now) " +
          "ON CONFLICT (session_id) DO UPDATE SET tainted_at = NULL, taint_epoch = session_policy.taint_epoch + 1, updated_at = excluded.updated_at " +
          "WHERE session_policy.owner_id = excluded.owner_id",
        { sessionId, ownerId, now },
      );
    },
    /** The target takes the source's mode and taint (a fork or a clone carries the same context). A new row starts at epoch 0; an existing row keeps its epoch, which never goes down. */
    inherit: (ownerId: string, sourceId: string, targetId: string, now: number): void => {
      db.transaction(() => {
        const source = read(ownerId, sourceId);
        if (!source) return;
        db.run(
          "INSERT INTO session_policy (session_id, owner_id, approval_mode, tainted_at, taint_epoch, updated_at) VALUES ($targetId, $ownerId, $mode, $taintedAt, 0, $now) " +
            "ON CONFLICT (session_id) DO UPDATE SET approval_mode = excluded.approval_mode, tainted_at = excluded.tainted_at, updated_at = excluded.updated_at " +
            "WHERE session_policy.owner_id = excluded.owner_id",
          { targetId, ownerId, mode: source.approvalMode, taintedAt: source.taintedAt, now },
        );
      });
    },
  };
}
export type SessionPolicyStore = ReturnType<typeof createSessionPolicyStore>;
