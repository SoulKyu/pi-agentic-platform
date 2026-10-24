import { PapError } from "@pap/contracts";
import type { Config } from "../../kernel/config.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TriggerStore } from "./store.ts";
import { removeTriggerSecret, triggerSecretsDir } from "./trigger-secrets.ts";
import type { TriggerChanged } from "./triggers.ts";

/** What the projects module asks of the automation module when a box project is deleted (boxes B1). */
export interface AutomationProjectPort {
  /** The owner's triggers filed under the project: the delete confirmation names them. */
  count(ownerId: string, projectId: string): number;
  /** Cancels the project's queued, running and quota-waiting tasks first, then removes its triggers and their secret files. */
  removeProject(ownerId: string, projectId: string): Promise<{ triggers: number }>;
}

export function createAutomationProjectPort(
  deps: { readonly db: Db; readonly config: Pick<Config, "home"> },
  logger: Logger,
  store: Pick<TriggerStore, "list" | "remove">,
  /** The runner's own Cancel: announced and ended as the board expects. */
  runner: { cancel(ownerId: string, taskId: string): Promise<unknown> },
  changed: (change: TriggerChanged) => void,
): AutomationProjectPort {
  const secretsDir = triggerSecretsDir(deps.config.home);
  const triggersOf = (ownerId: string, projectId: string) => store.list(ownerId, projectId);
  const activeTasks = (ownerId: string, projectId: string): string[] =>
    deps.db
      .all<{ id: string }>(
        `SELECT t.id AS id FROM tasks t JOIN triggers g ON g.id = t.trigger_id
          WHERE t.owner_id = $ownerId AND g.project_id = $projectId AND t.state IN ('queued', 'running', 'limited')
          ORDER BY t.created_at, t.id`,
        { ownerId, projectId },
      )
      .map((row) => row.id);
  return {
    count: (ownerId, projectId) => triggersOf(ownerId, projectId).length,
    async removeProject(ownerId, projectId) {
      for (const taskId of activeTasks(ownerId, projectId)) {
        try {
          await runner.cancel(ownerId, taskId);
        } catch (error) {
          // Moved by someone else meanwhile (started, cancelled): nothing left to cancel; the delete goes on.
          if (!(error instanceof PapError && (error.code === "conflict" || error.code === "not_found")))
            throw error;
        }
      }
      const rows = triggersOf(ownerId, projectId);
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
