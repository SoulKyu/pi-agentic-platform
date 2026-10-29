import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { deleteOwnerRows } from "./owner-rows.ts";

/** What each module gives to a member's delete: one internal call per module, with no Caller and no step-up. */
export interface DeleteDeps {
  readonly db: Db;
  readonly github: {
    /** Awaits the release of the owner's signing keys on GitHub; returns the keys left there. */
    releaseKeysOf(ownerId: string): Promise<number[]>;
  };
  readonly projects: { removeAll(ownerId: string): Promise<number> };
  readonly agents: { trashAll(ownerId: string): Promise<number> };
  readonly automation: { removeAll(ownerId: string): Promise<unknown> };
  readonly sessions: { removeAll(ownerId: string): Promise<unknown> };
  readonly push: { forgetOwner(ownerId: string): unknown };
  readonly search: { dropOwner(ownerId: string): void };
  /** A second revocation beside the disable's: the delete is the end of every token the user could still hold (UX2-R72). */
  readonly previews: { revokeOwner(ownerId: string): unknown };
  readonly vault: { dropOwner(ownerId: string): void };
  readonly auth: { deleteUser(userId: string): void };
  readonly logger: Pick<Logger, "info" | "warn">;
}

export interface DeleteCascade {
  /**
   * Everything the user owns, after the account is disabled and its machines stopped (the service did that first, so a failure
   * anywhere here leaves a disabled account and a retry finds the rest). Each step is awaited before the next; the first failure
   * is thrown. The order matters:
   *  - the signing keys are released on GitHub through the user token, which is in the vault, so before the vault goes (RT-12c);
   *  - box projects and agents go to their trash before the rows that name them;
   *  - the `users` row goes last: it cascades to the browser sessions, passkeys and tokens.
   */
  run(userId: string): Promise<void>;
}

export function createDeleteCascade(deps: DeleteDeps): DeleteCascade {
  return {
    async run(userId) {
      deps.previews.revokeOwner(userId);
      const left = await deps.github.releaseKeysOf(userId);
      if (left.length > 0) deps.logger.warn("user_delete_github_keys_left", { userId, keyIds: left });
      await deps.projects.removeAll(userId);
      // Before the agents: it cancels their running and queued tasks, which a busy agent's delete would refuse.
      await deps.automation.removeAll(userId);
      await deps.agents.trashAll(userId);
      await deps.sessions.removeAll(userId);
      deps.push.forgetOwner(userId);
      deps.search.dropOwner(userId);
      deps.vault.dropOwner(userId);
      const touched = deleteOwnerRows(deps.db, userId);
      deps.logger.info("user_deleted", { tables: touched.filter((entry) => entry.rows > 0).length });
      deps.auth.deleteUser(userId);
    },
  };
}
