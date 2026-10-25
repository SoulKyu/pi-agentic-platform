import type { HandlerTable } from "@pap/contracts";
import type { UsersService } from "./service.ts";

export type UsersAdminRpc = Pick<
  HandlerTable,
  | "users.list"
  | "users.invite"
  | "users.revokeInvite"
  | "users.setBudget"
  | "users.setDisabled"
  | "users.delete"
>;

/** Each handler makes one service call and lets typed errors through. */
export function usersAdminRpc(service: UsersService): UsersAdminRpc {
  return {
    "users.list": async () => service.list(),
    "users.invite": async ({ nameHint }, ctx) =>
      service.invite(ctx.caller, nameHint ?? null, ctx.origin ?? ""),
    "users.revokeInvite": async ({ inviteId }, ctx) => {
      service.revokeInvite(ctx.caller, inviteId);
      return { ok: true as const };
    },
    "users.setBudget": async ({ userId, dailyBudgetUsd }, ctx) => {
      service.setBudget(ctx.caller, userId, dailyBudgetUsd);
      return { ok: true as const };
    },
    "users.setDisabled": async ({ userId, disabled }, ctx) => {
      await service.setDisabled(ctx.caller, userId, disabled);
      return { ok: true as const };
    },
    "users.delete": async ({ userId }, ctx) => {
      await service.delete(ctx.caller, userId);
      return { ok: true as const };
    },
  };
}
