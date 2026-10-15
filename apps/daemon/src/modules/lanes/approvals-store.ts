import type { ScriptKind } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { scriptHash } from "./project-config.ts";

export interface Approval {
  readonly sha256: string;
  /** The approved text, kept for the "changed since you approved it" display (decision 30). */
  readonly script: string;
  readonly approvedAt: number;
}

export interface ApprovalsStore {
  get(ownerId: string, projectRoot: string, kind: ScriptKind): Approval | undefined;
  /** One row per (owner, project, kind): a new approval replaces the old one. */
  approve(ownerId: string, projectRoot: string, kind: ScriptKind, sha256: string, text: string): void;
}

/** The only writer of `lane_script_approvals`. */
export function createApprovalsStore(db: Db, clock: Clock): ApprovalsStore {
  return {
    get: (ownerId, projectRoot, kind) =>
      db.get<Approval>(
        `SELECT sha256, script, approved_at AS approvedAt FROM lane_script_approvals
         WHERE owner_id = $ownerId AND project_root = $projectRoot AND kind = $kind`,
        { ownerId, projectRoot, kind },
      ),
    approve(ownerId, projectRoot, kind, sha256, text) {
      // A row whose hash is not its text's would approve one script and show another.
      if (scriptHash(text) !== sha256) throw new Error("approval hash does not match its text");
      db.run(
        `INSERT INTO lane_script_approvals (owner_id, project_root, kind, sha256, script, approved_at)
         VALUES ($ownerId, $projectRoot, $kind, $sha256, $text, $now)
         ON CONFLICT (owner_id, project_root, kind)
         DO UPDATE SET sha256 = $sha256, script = $text, approved_at = $now`,
        { ownerId, projectRoot, kind, sha256, text, now: clock.now() },
      );
    },
  };
}
