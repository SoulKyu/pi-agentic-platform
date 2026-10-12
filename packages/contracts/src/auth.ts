import { z } from "zod";
import { defineMethod } from "./define.ts";
import { ALL_PERMISSIONS, type Permission } from "./permissions.ts";

/** What a token may hold (M5R64): never credentials (`auth:*`), never policy administration (owner Q7 b). */
export const TOKEN_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) => !permission.startsWith("auth:") && permission !== "policy:admin",
);
export const TokenPermission = z.enum(TOKEN_PERMISSIONS as [Permission, ...Permission[]]);
export type TokenPermission = z.infer<typeof TokenPermission>;

/** The only lifetimes offered; there is no "never" (M5R65). */
export const TOKEN_LIFETIMES_DAYS = [7, 30, 90, 365] as const;
export const MAX_TOKENS_PER_USER = 50;

/** `pap_` and 43 base64url characters: the prefix lets a secret scanner recognise a leak (M5R63). */
export const API_TOKEN_PATTERN = /^pap_[A-Za-z0-9_-]{43}$/;

export const TokenName = z.string().trim().min(1).max(64);

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
} as const;
