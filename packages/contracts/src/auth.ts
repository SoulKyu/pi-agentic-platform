import { z } from "zod";
import { defineMethod } from "./define.ts";
import { INVISIBLE } from "./policy.ts";
import { ALL_PERMISSIONS, type Permission } from "./permissions.ts";

/**
 * What a token may hold (M5R64): never credentials (`auth:*`), never policy administration (owner Q7 b), never Pi
 * administration (M7R39: it can make pap run a configured command or redirect provider traffic), never a terminal
 * (`terminal:*`, M8R2): a standing credential makes no code-running change. `lanes:admin` approves or runs code, sends it
 * out, reaches a forge or destroys work (M9R1).
 */
export const TOKEN_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) =>
    !permission.startsWith("auth:") &&
    !permission.startsWith("terminal:") &&
    permission !== "policy:admin" &&
    permission !== "pi:admin" &&
    permission !== "lanes:admin",
);
export const TokenPermission = z.enum(TOKEN_PERMISSIONS as [Permission, ...Permission[]]);
export type TokenPermission = z.infer<typeof TokenPermission>;

/** The only lifetimes offered; there is no "never" (M5R65). */
export const TOKEN_LIFETIMES_DAYS = [7, 30, 90, 365] as const;
export const MAX_TOKENS_PER_USER = 50;

/** `pap_` and 43 base64url characters: the prefix lets a secret scanner recognise a leak (M5R63). */
export const API_TOKEN_PATTERN = /^pap_[A-Za-z0-9_-]{43}$/;

export const TokenName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((name) => !INVISIBLE.test(name), "a name is one line of visible characters");

/** A token as the list shows it: never its value, never its hash. */
export const TokenView = z.object({
  id: z.string().min(1).max(128),
  name: TokenName,
  hint: z.string().length(4),
  permissions: z.array(TokenPermission).max(TOKEN_PERMISSIONS.length),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
});
export type TokenView = z.infer<typeof TokenView>;

/** Browser and system families as codes: the web translates them, the daemon never sends the raw user agent. */
export const DEVICE_BROWSERS = ["chrome", "firefox", "safari", "edge", "other"] as const;
export const DEVICE_SYSTEMS = ["linux", "macos", "windows", "ios", "android", "other"] as const;
export type DeviceBrowser = (typeof DEVICE_BROWSERS)[number];
export type DeviceOs = (typeof DEVICE_SYSTEMS)[number];
export const MAX_DEVICES_LISTED = 200;

/** A browser session as the list shows it: its public id is random and is never the cookie or its hash (M5R73). */
export const DeviceView = z.object({
  id: z.string().min(1).max(128),
  current: z.boolean(),
  browser: z.enum(DEVICE_BROWSERS),
  os: z.enum(DEVICE_SYSTEMS),
  ip: z.string().max(64).nullable(),
  method: z.enum(["password", "passkey", "setup"]).nullable(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type DeviceView = z.infer<typeof DeviceView>;

export const MAX_PASSKEYS_LISTED = 100;

/** A passkey as the list shows it: `id` is the first 32 hex characters of the sha256 of its credential id (M5R76). */
export const PasskeyView = z.object({
  id: z.string().min(1).max(128),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
  transports: z.array(z.string().max(32)).max(8),
});
export type PasskeyView = z.infer<typeof PasskeyView>;

const Ok = z.object({ ok: z.literal(true) });

export const authMethods = {
  "auth.tokens.list": defineMethod({
    name: "auth.tokens.list",
    permission: "auth:read",
    idempotent: true,
    params: z.object({}),
    result: z.object({ tokens: z.array(TokenView).max(MAX_TOKENS_PER_USER) }),
    errors: [],
  }),
  "auth.tokens.create": defineMethod({
    name: "auth.tokens.create",
    permission: "auth:admin",
    idempotent: false,
    secretResult: true,
    params: z.object({
      name: TokenName,
      permissions: z
        .array(TokenPermission)
        .min(1)
        .max(TOKEN_PERMISSIONS.length)
        .refine((list) => new Set(list).size === list.length, "duplicate permission"),
      expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]),
    }),
    // The value is in this response only: a replay of the commandId answers `conflict`, never the value again (M5R68).
    result: z.object({ token: TokenView, value: z.string().regex(API_TOKEN_PATTERN) }),
    errors: ["step_up_required", "limit_reached", "bad_request"],
  }),
  "auth.tokens.revoke": defineMethod({
    name: "auth.tokens.revoke",
    permission: "auth:admin",
    idempotent: false,
    params: z.object({ tokenId: z.string().min(1).max(128) }),
    result: Ok,
    errors: ["not_found"],
  }),
  "auth.devices.list": defineMethod({
    name: "auth.devices.list",
    permission: "auth:read",
    idempotent: true,
    params: z.object({}),
    result: z.object({ devices: z.array(DeviceView).max(MAX_DEVICES_LISTED) }),
    errors: [],
  }),
  // Signing out this browser is revoking its own id. Neither device method needs a step-up: they only take access away.
  "auth.devices.revoke": defineMethod({
    name: "auth.devices.revoke",
    permission: "auth:admin",
    idempotent: false,
    params: z.object({ deviceId: z.string().min(1).max(128) }),
    result: Ok,
    errors: ["not_found"],
  }),
  "auth.devices.revokeOthers": defineMethod({
    name: "auth.devices.revokeOthers",
    permission: "auth:admin",
    idempotent: false,
    params: z.object({}),
    result: z.object({ revoked: z.number().int().nonnegative() }),
    errors: [],
  }),
  "auth.passkeys.list": defineMethod({
    name: "auth.passkeys.list",
    permission: "auth:read",
    idempotent: true,
    params: z.object({}),
    result: z.object({ passkeys: z.array(PasskeyView).max(MAX_PASSKEYS_LISTED) }),
    errors: [],
  }),
  // Removing a passkey also signs out the browsers it opened; `revoked` counts them. The last one can go: the password stays.
  "auth.passkeys.remove": defineMethod({
    name: "auth.passkeys.remove",
    permission: "auth:admin",
    idempotent: false,
    params: z.object({ passkeyId: z.string().min(1).max(128) }),
    result: z.object({ revoked: z.number().int().nonnegative() }),
    errors: ["step_up_required", "not_found"],
  }),
} as const;
