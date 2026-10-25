import { PapError } from "@pap/contracts";
import type { Config } from "../../kernel/config.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TriggerStore } from "./store.ts";
import { removeTriggerSecret, triggerSecretsDir } from "./trigger-secrets.ts";
import type { TriggerChanged } from "./triggers.ts";

/** What a member's delete (A5b) asks of the automation module. */
export interface AutomationOwnerCascade {
  /**
   * Cancels the owner's queued, running and quota-waiting tasks, then removes every trigger of theirs (project, agent and
   * project-less) with its secret file. The task rows stay for the owner-row sweep, which runs once the sessions are gone.
   */
  removeAll(ownerId: string): Promise<{ triggers: number }>;
}

export function createAutomationOwnerCascade(
  deps: { readonly db: Db; readonly config: Pick<Config, "home"> },
  logger: Logger,
  store: Pick<TriggerStore, "list" | "remove">,
  runner: { cancel(ownerId: string, taskId: string): Promise<unknown> },
  changed: (change: TriggerChanged) => void,
): AutomationOwnerCascade {
  const secretsDir = triggerSecretsDir(deps.config.home);
  return {
    async removeAll(ownerId) {
      const active = deps.db.all<{ id: string }>(
        "SELECT id FROM tasks WHERE owner_id = $ownerId AND state IN ('queued', 'running', 'limited') ORDER BY created_at, id",
        { ownerId },
      );
      for (const { id } of active) {
        try {
          await runner.cancel(ownerId, id);
        } catch (error) {
          if (!(error instanceof PapError && (error.code === "conflict" || error.code === "not_found")))
            throw error;
        }
      }
      const rows = store.list(ownerId, undefined);
      for (const row of rows) {
        store.remove(ownerId, row.id);
        try {
          removeTriggerSecret(secretsDir, row.id);
        } catch (error) {
          logger.warn("trigger_secret_remove_failed", { err: error });
        }
        try {
          changed({ ownerId, triggerId: row.id, removed: true });
        } catch (error) {
          logger.warn("trigger_change_listener_failed", { err: error });
        }
      }
      return { triggers: rows.length };
    },
  };
}
