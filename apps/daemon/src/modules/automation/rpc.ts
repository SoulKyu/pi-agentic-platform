import type { Caller, HandlerTable } from "@pap/contracts";
import type { DryRun } from "./dry-run.ts";
import type { Journal } from "./journal.ts";
import type { Manual } from "./manual.ts";
import type { ReleaseTarget, ReleaseTools } from "./release-tools.ts";
import type { Runner } from "./runner.ts";
import type { TasksStream } from "./tasks-stream.ts";
import type { Triggers } from "./triggers.ts";

export type AutomationRpc = Pick<
  HandlerTable,
  | "automation.triggers.list"
  | "automation.triggers.get"
  | "automation.triggers.create"
  | "automation.triggers.update"
  | "automation.triggers.delete"
  | "automation.triggers.setEnabled"
  | "automation.triggers.rotateSecret"
  | "automation.tasks.cancel"
  | "automation.tasks.retry"
  | "automation.tasks.releaseTools"
  | "automation.fire"
  | "automation.dryRun"
  | "automation.journal"
  | "automation.failures.dismiss"
  | "subscribe.tasks"
>;

/** What the task handlers call: the owner comes from the transport, never from the params. */
export interface TaskActions {
  cancel(ownerId: string, taskId: string): Promise<{ taskId: string }>;
  retry(ownerId: string, taskId: string, caller: Caller): { taskId: string };
  releaseTools(caller: Caller, target: ReleaseTarget): Promise<{ taskId: string | null; sessionId: string }>;
  dismiss(ownerId: string, effectId: number): void;
}

/** A token's retry is budget-gated, refused on a disabled trigger and runs under the trigger's current policy; a browser session's is none of these (M10R41, owner m10q5). */
export const taskActions = (
  runner: Runner,
  stream: TasksStream,
  releaseTools: ReleaseTools,
): TaskActions => ({
  cancel: runner.cancel,
  retry: (ownerId, taskId, caller) =>
    runner.retry(ownerId, taskId, { gated: caller.kind === "token", asToken: caller.kind === "token" }),
  releaseTools,
  dismiss: stream.dismiss,
});

/** Manual fire, dry-run and the journal (M10R63 to M10R65): each is one service call. */
export interface Operations {
  readonly manual: Pick<Manual, "fire">;
  readonly dryRun: Pick<DryRun, "run">;
  readonly journal: Pick<Journal, "page">;
}

export function automationRpc(triggers: Triggers, tasks: TaskActions, operations: Operations): AutomationRpc {
  return {
    "automation.triggers.list": async (params, ctx) => triggers.list(ctx.caller, params),
    "automation.triggers.get": async ({ triggerId }, ctx) => triggers.view(ctx.caller, triggerId),
    "automation.triggers.create": async ({ input }, ctx) => triggers.create(ctx.caller, input),
    "automation.triggers.update": async (params, ctx) => triggers.update(ctx.caller, params),
    "automation.triggers.delete": async ({ triggerId }, ctx) => triggers.remove(ctx.caller, triggerId),
    "automation.triggers.setEnabled": async ({ triggerId, enabled }, ctx) =>
      triggers.setEnabled(ctx.caller, triggerId, enabled),
    "automation.triggers.rotateSecret": async ({ triggerId }, ctx) =>
      triggers.rotateSecret(ctx.caller, triggerId),
    "automation.tasks.cancel": async ({ taskId }, ctx) => tasks.cancel(ctx.caller.userId, taskId),
    "automation.tasks.retry": async ({ taskId }, ctx) => tasks.retry(ctx.caller.userId, taskId, ctx.caller),
    "automation.tasks.releaseTools": async (params, ctx) => tasks.releaseTools(ctx.caller, params),
    "automation.fire": async ({ triggerId, payload }, ctx) =>
      operations.manual.fire(ctx.caller, triggerId, payload),
    "automation.dryRun": async (params, ctx) => operations.dryRun.run(ctx.caller, params),
    "automation.journal": async ({ triggerId, before }, ctx) =>
      operations.journal.page(ctx.caller.userId, triggerId, before),
    "automation.failures.dismiss": async ({ effectId }, ctx) => {
      tasks.dismiss(ctx.caller.userId, effectId);
      return { ok: true as const };
    },
    "subscribe.tasks": async ({ after }, ctx) => ({
      sub: ctx.openSubscription("tasks", ctx.caller.userId, after),
    }),
  };
}
