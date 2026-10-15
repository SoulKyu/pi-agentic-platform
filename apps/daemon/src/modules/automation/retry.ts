import { PapError } from "@pap/contracts";
import type { Fire } from "./fire.ts";
import { parsePolicy, type TaskStore } from "./tasks.ts";
import type { TriggerRecord } from "./triggers.ts";

export interface RetryDeps {
  readonly store: Pick<TaskStore, "getOwned">;
  readonly triggers: { get(ownerId: string, id: string): TriggerRecord | null };
  readonly fire: Fire;
}

/**
 * M10R41: Retry fires the task again with the prompt, the taint and the policy it had, through the one fire path. A
 * token's retry (`asToken`) is not the owner's own word: it needs an enabled trigger and runs under the trigger's
 * current tools, mode, env and caps, so a list the owner has since narrowed is never widened by it.
 */
export function createRetry(deps: RetryDeps) {
  return function retry(
    ownerId: string,
    taskId: string,
    options: { readonly gated: boolean; readonly exemptDisabled?: boolean; readonly asToken?: boolean },
  ): { taskId: string } {
    const row = deps.store.getOwned(ownerId, taskId);
    if (!row) throw new PapError("not_found");
    if (row.state !== "failed" && row.state !== "interrupted" && row.state !== "cancelled")
      throw new PapError("conflict");
    const policy = parsePolicy(row.policy);
    const trigger = row.trigger_id === null ? null : deps.triggers.get(ownerId, row.trigger_id);
    // A task of a deleted trigger has no config to run under, and the journal line needs the trigger.
    if ((policy === null && options.asToken !== true) || trigger === null) throw new PapError("conflict");
    const result = deps.fire(trigger.id, trigger.revision, {
      ownerId,
      source: "retry",
      payload: null,
      precheck: null,
      dedupKey: null,
      title: row.title,
      detail: row.detail,
      // The budget gates a token's retry and the boot's; a browser session's runs on (its spend still counts, M10R66).
      gated: options.gated,
      // The owner pressing Retry is asking by hand, like a manual fire; the boot's retry respects a switch-off.
      gates: { exemptDisabled: options.asToken === true ? false : (options.exemptDisabled ?? true) },
      retry: {
        taskId: row.id,
        prompt: row.prompt,
        tainted: row.tainted === 1,
        policy: options.asToken === true ? null : policy,
        caps:
          options.asToken === true
            ? null
            : {
                maxRunMs: row.max_run_ms,
                maxRunUsd: row.max_run_usd,
                retryOnInterrupt: row.retry_on_interrupt === 1,
              },
      },
    });
    if (result.verdict === "fired" && result.taskId !== undefined) return { taskId: result.taskId };
    if (result.verdict === "paused") throw new PapError("automation_paused");
    if (result.verdict === "queue_full") throw new PapError("rate_limited");
    if (result.verdict === "budget") throw new PapError("budget_reached");
    throw new PapError("conflict");
  };
}
