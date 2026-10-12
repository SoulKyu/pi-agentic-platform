import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_TOKEN_PATTERN,
  MAX_TOKENS_PER_USER,
  PapError,
  TOKEN_LIFETIMES_DAYS,
  TOKEN_PERMISSIONS,
  type Caller,
  type Permission,
  type TokenView,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import { sha256Hex } from "../../kernel/ids.ts";
import type { AuditPort } from "../audit/index.ts";
import { requireStepUp } from "./step-up.ts";
import type { TokenRow, TokenStore } from "./token-store.ts";

const DAY_MS = 24 * 3600 * 1000;
const LAST_USE_EVERY_MS = 10 * 60_000;
const GRANTABLE: ReadonlySet<Permission> = new Set(TOKEN_PERMISSIONS);

export interface TokenDeps {
  readonly store: TokenStore;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
  newId(): string;
  ownerPermissions(userId: string): ReadonlySet<Permission>;
}

export interface TokenInput {
  readonly name: string;
  readonly permissions: readonly Permission[];
  readonly expiresInDays: number;
}

// What a view shows is filtered like what a caller gets, so a damaged row cannot leak a permission into the list.
const viewOf = (row: TokenRow): TokenView => ({
  id: row.id,
  name: row.name,
  hint: row.hint,
  permissions: row.permissions.filter((p) => GRANTABLE.has(p)) as TokenView["permissions"],
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
});

const sameHash = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

function require(caller: Caller, permission: Permission): void {
  if (!caller.permissions.has(permission)) throw new PapError("forbidden");
}

export function createTokenService(deps: TokenDeps) {
  // Last-use writes by token id; an entry leaves with its token, so the map never outgrows the live tokens (M5R66).
  const lastWrite = new Map<string, number>();
  const dropExpired = (userId: string, now: number): void => {
    for (const id of deps.store.deleteExpired(userId, now)) lastWrite.delete(id);
  };
  return {
    list(caller: Caller): TokenView[] {
      require(caller, "auth:read");
      dropExpired(caller.userId, deps.clock.now());
      return deps.store.list(caller.userId).map(viewOf);
    },
    create(caller: Caller, input: TokenInput): { token: TokenView; value: string } {
      const now = deps.clock.now();
      require(caller, "auth:admin");
      requireStepUp(caller, now);
      // The schema already refused these; the stored list is checked again here, whoever called (owner Q7 b).
      const unique = new Set(input.permissions);
      const valid =
        input.permissions.length > 0 &&
        unique.size === input.permissions.length &&
        input.permissions.every((p) => GRANTABLE.has(p)) &&
        (TOKEN_LIFETIMES_DAYS as readonly number[]).includes(input.expiresInDays);
      if (!valid) throw new PapError("bad_request");
      dropExpired(caller.userId, now);
      if (deps.store.count(caller.userId) >= MAX_TOKENS_PER_USER) throw new PapError("limit_reached");
      const value = `pap_${randomBytes(32).toString("base64url")}`;
      const row: TokenRow = {
        id: deps.newId(),
        userId: caller.userId,
        name: input.name,
        hint: value.slice(-4),
        secretHash: sha256Hex(value),
        permissions: [...input.permissions],
        createdAt: now,
        expiresAt: now + input.expiresInDays * DAY_MS,
        lastUsedAt: null,
      };
      deps.store.insert(row);
      deps.audit.append({
        ownerId: caller.userId,
        actor: "user",
        kind: "auth",
        reason: "token_created",
        detail: {
          tokenId: row.id,
          name: row.name,
          permissions: row.permissions.length,
          expiresAt: row.expiresAt,
        },
      });
      return { token: viewOf(row), value };
    },
    revoke(caller: Caller, tokenId: string): void {
      require(caller, "auth:admin");
      if (!deps.store.delete(caller.userId, tokenId)) throw new PapError("not_found");
      lastWrite.delete(tokenId);
      deps.audit.append({
        ownerId: caller.userId,
        actor: "user",
        kind: "auth",
        reason: "token_revoked",
        detail: { tokenId },
      });
    },
    /** A wrong, unknown, expired or malformed value all answer null; a malformed one never reaches the database. */
    authenticate(value: string | undefined, options: { readonly slide: boolean }): Caller | null {
      if (value === undefined || !API_TOKEN_PATTERN.test(value)) return null;
      const hash = sha256Hex(value);
      const row = deps.store.findByHash(hash);
      const now = deps.clock.now();
      if (!row || !sameHash(row.secretHash, hash) || row.expiresAt <= now) return null;
      if (options.slide && now - (lastWrite.get(row.id) ?? -Infinity) >= LAST_USE_EVERY_MS) {
        lastWrite.set(row.id, now);
        try {
          deps.store.touch(row.id, now);
        } catch (error) {
          // A database written by a newer pap is read-only: the token is still valid, its last use is just not kept.
          if (!isReadOnlyError(error)) throw error;
        }
      }
      // Both filters: what a token may ever hold, and what the owner holds now. A tampered row widens nothing.
      const owner = deps.ownerPermissions(row.userId);
      const permissions = new Set(row.permissions.filter((p) => GRANTABLE.has(p) && owner.has(p)));
      return { userId: row.userId, permissions, kind: "token", credentialId: row.id, stepUpUntil: 0 };
    },
    lastUseTracked: (): number => lastWrite.size,
  };
}

export type TokenService = ReturnType<typeof createTokenService>;
