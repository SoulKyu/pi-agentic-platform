import { z } from "zod";
import { defineMethod } from "./define.ts";
import { ROLES } from "./roles.ts";

const Id = z.string().min(1).max(128);
const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const Ok = Params({ ok: z.literal(true) });

export const USERS_LIMITS = { nameHint: 64, budgetMaxUsd: 1000 } as const;

export const UserView = Params({
  id: Id,
  username: z.string().min(1).max(64),
  role: z.enum(ROLES),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
  disabled: z.boolean(),
  /** USD per day; `null` for the owner, who has no cap. */
  budgetUsd: z.number().min(0).max(USERS_LIMITS.budgetMaxUsd).nullable(),
  /** The member line: every API or unknown-billed run of today (the owner's time zone). */
  spentTodayUsd: z.number().min(0),
  spent7dUsd: z.number().min(0),
  boxesRunning: z.number().int().min(0),
});
export type UserView = z.infer<typeof UserView>;

export const InviteView = Params({
  id: Id,
  nameHint: z.string().max(USERS_LIMITS.nameHint).nullable(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type InviteView = z.infer<typeof InviteView>;

export const ProviderSharingView = Params({
  provider: z.string().min(1).max(128),
  label: z.string().max(256),
  auth: z.enum(["api_key", "oauth"]).nullable(),
  shared: z.boolean(),
  /** False for a subscription (oauth) provider: boxes never get it. */
  servable: z.boolean(),
});
export type ProviderSharingView = z.infer<typeof ProviderSharingView>;

// Browser only (USERS_BROWSER_ONLY): `users:*` is outside the token permissions, and the set says so for the service.
export const usersMethods = {
  "users.list": defineMethod({
    name: "users.list",
    permission: "users:read",
    idempotent: true,
    params: Params({}),
    result: Params({ users: z.array(UserView).max(1000), invites: z.array(InviteView).max(1000) }),
    errors: [],
  }),
  /** The link holds the token: it is shown once and never stored in a receipt. */
  "users.invite": defineMethod({
    name: "users.invite",
    permission: "users:admin",
    idempotent: false,
    secretResult: true,
    params: Params({ nameHint: z.string().min(1).max(USERS_LIMITS.nameHint).optional() }),
    result: Params({ url: z.string().url().max(2048), expiresAt: z.number().int(), invite: InviteView }),
    errors: ["step_up_required", "limit_reached"],
  }),
  "users.revokeInvite": defineMethod({
    name: "users.revokeInvite",
    permission: "users:admin",
    idempotent: false,
    params: Params({ inviteId: Id }),
    result: Ok,
    errors: ["not_found"],
  }),
  "users.setBudget": defineMethod({
    name: "users.setBudget",
    permission: "users:admin",
    idempotent: false,
    params: Params({ userId: Id, dailyBudgetUsd: z.number().min(0).max(USERS_LIMITS.budgetMaxUsd) }),
    result: Ok,
    errors: ["not_found", "forbidden", "bad_request"],
  }),
  /** Enabling again asks the password (the step-up applies when `disabled` is false). */
  "users.setDisabled": defineMethod({
    name: "users.setDisabled",
    permission: "users:admin",
    idempotent: false,
    params: Params({ userId: Id, disabled: z.boolean() }),
    result: Ok,
    errors: ["step_up_required", "forbidden", "not_found"],
  }),
  "users.delete": defineMethod({
    name: "users.delete",
    permission: "users:admin",
    idempotent: false,
    params: Params({ userId: Id }),
    result: Ok,
    errors: ["step_up_required", "forbidden", "not_found"],
  }),
  "users.providers": defineMethod({
    name: "users.providers",
    permission: "users:read",
    idempotent: true,
    params: Params({}),
    result: Params({ providers: z.array(ProviderSharingView).max(500) }),
    errors: [],
  }),
  "users.setProviderShared": defineMethod({
    name: "users.setProviderShared",
    permission: "users:admin",
    idempotent: false,
    params: Params({ provider: z.string().min(1).max(128), shared: z.boolean() }),
    result: Ok,
    errors: ["bad_request", "not_found"],
  }),
};

export const USERS_BROWSER_ONLY: ReadonlySet<string> = new Set(Object.keys(usersMethods));
