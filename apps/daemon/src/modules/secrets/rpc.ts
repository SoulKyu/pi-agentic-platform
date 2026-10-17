import type { HandlerTable } from "@pap/contracts";
import type { SecretRequests } from "./requests.ts";
import type { Secrets } from "./service.ts";

export type SecretsRpc = Pick<HandlerTable, "secrets.list" | "secrets.set" | "secrets.delete">;
export type SecretRequestsRpc = Pick<HandlerTable, "secrets.answerRequest" | "secrets.declineRequest">;

/** Each handler decodes (the dispatcher did), calls one service method and lets typed errors through (C §1.4.3). */
export function secretsRpc(secrets: Pick<Secrets, "list" | "set" | "remove">): SecretsRpc {
  return {
    "secrets.list": async ({ agentId }, ctx) => secrets.list(ctx.caller, agentId),
    "secrets.set": async (params, ctx) => secrets.set(ctx.caller, params),
    "secrets.delete": async (params, ctx) => secrets.remove(ctx.caller, params),
  };
}

/** The owner's answer to an agent's secret request, and its decline (Task 18). */
export function secretRequestsRpc(requests: Pick<SecretRequests, "answer" | "decline">): SecretRequestsRpc {
  return {
    "secrets.answerRequest": async (params, ctx) => (requests.answer(ctx.caller, params), {}),
    "secrets.declineRequest": async (params, ctx) => (requests.decline(ctx.caller, params), {}),
  };
}
