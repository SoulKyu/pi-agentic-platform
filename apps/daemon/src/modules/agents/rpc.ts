import type { HandlerTable } from "@pap/contracts";
import type { QueueTask } from "./queue.ts";
import type { SandboxMethods } from "./sandbox.ts";
import type { Requests } from "./requests.ts";
import type { Permissions } from "./permissions.ts";
import type { Prompts } from "./prompts.ts";
import type { Quarantine } from "./quarantine.ts";
import type { Agents } from "./service.ts";
import type { AgentReads } from "./status.ts";
import type { Threads } from "./threads.ts";
import type { TrashPurge } from "./trash-purge.ts";
import type { Unread } from "./unread.ts";

export type AgentsRpc = Pick<
  HandlerTable,
  | "agents.list"
  | "agents.get"
  | "agents.trash"
  | "agents.create"
  | "agents.update"
  | "agents.delete"
  | "agents.sandboxStatus"
  | "agents.recheckSandbox"
  | "agents.openThread"
  | "agents.resetThread"
  | "agents.markRead"
  | "agents.events"
  | "agents.status"
  | "agents.setPaused"
  | "agents.queueTask"
  | "agents.answerApproval"
  | "agents.quarantine"
  | "agents.permissions"
  | "agents.prompts"
  | "agents.prompt"
  | "agents.purgeTrash"
  | "subscribe.agents"
>;

/** Task 21: the incident playbook, the permissions sheet and the prompt chips. */
export interface AgentSafetyServices {
  readonly quarantine: Pick<Quarantine, "run">;
  readonly permissions: Pick<Permissions, "view">;
  readonly prompts: Pick<Prompts, "list" | "read">;
  readonly trash: Pick<TrashPurge, "purge">;
}

/** Each handler decodes (the dispatcher did), calls one service method and lets typed errors through (C §1.4.3). */
export function agentsRpc(
  agents: Pick<Agents, "list" | "view" | "trash" | "create" | "update" | "remove" | "pause">,
  sandbox: SandboxMethods,
  threads: Threads,
  unread: Pick<Unread, "markRead">,
  reads: AgentReads,
  queueTask: QueueTask,
  requests: Pick<Requests, "answer">,
  safety: AgentSafetyServices,
): AgentsRpc {
  return {
    "agents.list": async (_params, ctx) => agents.list(ctx.caller),
    "agents.get": async ({ agentId }, ctx) => agents.view(ctx.caller, agentId),
    "agents.trash": async (_params, ctx) => agents.trash(ctx.caller),
    "agents.create": async ({ input }, ctx) => agents.create(ctx.caller, input),
    "agents.update": async (params, ctx) => agents.update(ctx.caller, params),
    "agents.delete": async ({ agentId }, ctx) => agents.remove(ctx.caller, agentId),
    "agents.sandboxStatus": async () => sandbox.status(),
    "agents.recheckSandbox": async () => sandbox.recheck(),
    "agents.openThread": async ({ agentId }, ctx) => threads.open(ctx.caller.userId, agentId),
    "agents.resetThread": async ({ agentId }, ctx) => {
      await threads.reset(ctx.caller, agentId);
      return {};
    },
    "agents.markRead": async ({ agentId }, ctx) => {
      unread.markRead(ctx.caller.userId, agentId);
      return {};
    },
    "agents.events": async (params, ctx) => reads.events(ctx.caller, params),
    "agents.status": async ({ agentId }, ctx) => reads.status(ctx.caller, agentId),
    "agents.setPaused": async ({ agentId, paused }, ctx) => agents.pause(ctx.caller, agentId, paused),
    "agents.queueTask": async (params, ctx) => queueTask(ctx.caller, params),
    // The owner's own rail, like `inbox`: the key is the caller, never a param.
    "agents.answerApproval": async ({ requestId, approved }, ctx) => {
      requests.answer(ctx.caller, requestId, approved);
      return {};
    },
    "agents.quarantine": async ({ agentId }, ctx) => safety.quarantine.run(ctx.caller, agentId),
    "agents.permissions": async ({ agentId }, ctx) => safety.permissions.view(ctx.caller, agentId),
    "agents.prompts": async ({ agentId }, ctx) => safety.prompts.list(ctx.caller, agentId),
    "agents.prompt": async ({ agentId, name }, ctx) => safety.prompts.read(ctx.caller, agentId, name),
    "agents.purgeTrash": async ({ agentId }, ctx) => {
      await safety.trash.purge(ctx.caller, agentId);
      return { ok: true };
    },
    "subscribe.agents": async ({ after }, ctx) => ({
      sub: ctx.openSubscription("agents", ctx.caller.userId, after),
    }),
  };
}
