import { PapError, permissionsOf, type Permission, type Role } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import type { StepUps } from "./step-up.ts";
import type { AuthStore, AuthUserRow } from "./store.ts";
import type { TokenStore } from "./token-store.ts";

const LAST_SEEN_EVERY_MS = 60_000;
const MAX_TRACKED_USERS = 1024;

/** The permissions of a user by role; an unknown user holds nothing. */
export const permissionsOfRole = (role: Role | null): ReadonlySet<Permission> =>
  role === null ? new Set() : permissionsOf(role);

/** A correct credential of a disabled account is refused by name, so the owner's own users can tell why. */
export function assertEnabled(user: { readonly disabledAt: number | null } | undefined): void {
  if (user && user.disabledAt !== null) throw new PapError("account_disabled");
}

/** `users.last_seen_at`, written at most once a minute per user, on the auth clock. A read-only database skips it. */
export function createLastSeen(store: Pick<AuthStore, "touchLastSeen">, clock: Clock) {
  const written = new Map<string, number>();
  return (userId: string): void => {
    const now = clock.now();
    if (now - (written.get(userId) ?? -Infinity) < LAST_SEEN_EVERY_MS) return;
    if (written.size >= MAX_TRACKED_USERS) written.clear();
    written.set(userId, now);
    try {
      store.touchLastSeen(userId, now);
    } catch (error) {
      if (!isReadOnlyError(error)) throw error;
    }
  };
}

export interface UserAdmin {
  ownerId(): string | null;
  roleOf(userId: string): Role | null;
  /** Whether the host gate applies: true for a member and for an id with no user, false only for the owner. */
  isMember(userId: string): boolean;
  /** Whether the account is disabled; true for an id with no user (fails closed, like isMember). */
  isDisabled(userId: string): boolean;
  userIds(): string[];
  users(): AuthUserRow[];
  insertMember(input: { id: string; username: string; passwordHash: string; createdAt: number }): boolean;
  setDisabled(userId: string, disabled: boolean): void;
  setBudget(userId: string, usd: number | null): void;
  budgetOf(userId: string): number | null;
  /** Deletes the user's browser sessions and tokens and forgets their step-up marks. */
  revokeAll(userId: string): void;
  deleteUser(userId: string): void;
}

export function createUserAdmin(deps: {
  readonly store: AuthStore;
  readonly tokenStore: TokenStore;
  readonly stepUps: StepUps;
  readonly clock: Clock;
}): UserAdmin {
  const { store } = deps;
  const roleOf = (userId: string): Role | null => store.findUserById(userId)?.role ?? null;
  const refuseOwner = (userId: string): void => {
    if (roleOf(userId) === "owner") throw new PapError("forbidden");
  };
  const revokeAll = (userId: string): void => {
    for (const idHash of store.deleteSessionsOfUser(userId)) deps.stepUps.forget(idHash);
    deps.tokenStore.deleteAllOf(userId);
  };
  return {
    ownerId: () => store.ownerId(),
    roleOf,
    // Fails closed: everyone who is not the owner is gated, an unknown or deleted id included.
    isMember: (userId) => roleOf(userId) !== "owner",
    // Fails closed like isMember: an unknown or deleted id counts as disabled.
    isDisabled: (userId) => {
      const user = store.findUserById(userId);
      return user === undefined || user.disabledAt !== null;
    },
    userIds: () => store.userIds(),
    users: () => store.listUsers(),
    insertMember: (input) => store.insertMember(input),
    setDisabled(userId, disabled) {
      refuseOwner(userId);
      // One transaction: a failure leaves the account enabled, never disabled with credentials that Enable would revive.
      if (disabled) {
        for (const idHash of store.disableAndRevoke(userId, deps.clock.now())) deps.stepUps.forget(idHash);
      } else store.setDisabledAt(userId, null);
    },
    setBudget: (userId, usd) => store.setBudget(userId, usd),
    budgetOf: (userId) => store.budgetOf(userId),
    revokeAll,
    deleteUser(userId) {
      refuseOwner(userId);
      revokeAll(userId);
      store.deleteUser(userId);
    },
  };
}
