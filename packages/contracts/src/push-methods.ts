import { z } from "zod";
import { defineMethod } from "./define.ts";
import { PUSH_ID, PUSH_LIMITS, PushSubscriptionInput, PushTarget } from "./push.ts";

const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const Ok = Params({ ok: z.literal(true) });

/** Why push is off, or how ready the origin is (`kernel/push-readiness.ts`, M12R38). */
export const PUSH_OFF_REASONS = ["keys_unreadable", "insecure_http", "read_only"] as const;
export const PUSH_READINESS = ["ready", "localhost_only", "insecure_http", "origin_mismatch"] as const;
export const PUSH_FAILURE_REASONS = ["retry_exhausted", "rejected", "refused", "no_target"] as const;

export const PushConfig = Params({
  publicKey: z.string().max(128).nullable(),
  status: z.enum(["on", "off"]),
  reason: z.enum(PUSH_OFF_REASONS).nullable(),
  readiness: Params({ status: z.enum(PUSH_READINESS), hint: z.string().max(200).optional() }),
  subscribed: z.number().int().min(0),
  max: z.number().int().min(0),
  lastFailure: Params({ at: z.number().int(), reason: z.enum(PUSH_FAILURE_REASONS) }).nullable(),
  keysReset: Params({ at: z.number().int(), purged: z.number().int().min(0) }).nullable(),
});
export type PushConfig = z.infer<typeof PushConfig>;

/** A device as the list shows it: the push service's host only, never the endpoint, a key or a payload (M12R10). */
export const PushDeviceView = Params({
  id: z.string().min(1).max(128),
  label: z.string().max(PUSH_LIMITS.labelMax),
  host: z.string().max(255),
  createdAt: z.number().int(),
  lastOkAt: z.number().int().nullable(),
  current: z.boolean(),
});
export type PushDeviceView = z.infer<typeof PushDeviceView>;

/**
 * Every `push.*` method is for a browser session: the service refuses a token before any read (M12R10). Mutations are
 * `idempotent: false` with a command id (M1 checklist).
 */
export const pushMethods = {
  "push.config": defineMethod({
    name: "push.config",
    permission: "settings:read",
    idempotent: true,
    params: Params({}),
    result: PushConfig,
    errors: ["forbidden"],
  }),
  "push.subscribe": defineMethod({
    name: "push.subscribe",
    permission: "settings:operate",
    idempotent: false,
    params: Params({ subscription: PushSubscriptionInput }),
    result: Params({ id: z.string().min(1).max(128) }),
    errors: [
      "bad_request",
      "capacity",
      "conflict",
      "forbidden",
      "rate_limited",
      "push_unavailable",
      "push_revoked",
      "read_only",
    ],
  }),
  "push.list": defineMethod({
    name: "push.list",
    permission: "settings:read",
    idempotent: true,
    params: Params({}),
    result: Params({ items: z.array(PushDeviceView).max(PUSH_LIMITS.subscriptionsPerOwner) }),
    errors: ["forbidden"],
  }),
  "push.revoke": defineMethod({
    name: "push.revoke",
    permission: "settings:operate",
    idempotent: false,
    params: Params({ id: z.string().min(1).max(128) }),
    result: Ok,
    errors: ["not_found", "forbidden", "read_only"],
  }),
  "push.test": defineMethod({
    name: "push.test",
    permission: "settings:operate",
    idempotent: false,
    params: Params({}),
    result: Params({ delivered: z.number().int().min(0), dropped: z.number().int().min(0) }),
    errors: ["rate_limited", "push_unavailable", "forbidden"],
  }),
  // A heartbeat: re-sent every 20 s by an open tab, so it is idempotent (M12R11).
  "push.presence": defineMethod({
    name: "push.presence",
    permission: "settings:read",
    idempotent: true,
    params: Params({ focused: z.boolean() }),
    result: Ok,
    errors: ["capacity", "forbidden"],
  }),
  "push.open": defineMethod({
    name: "push.open",
    permission: "settings:read",
    idempotent: true,
    params: Params({ id: z.string().regex(PUSH_ID) }),
    result: Params({ target: PushTarget }),
    errors: ["not_found", "forbidden"],
  }),
} as const;
