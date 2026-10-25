import { PapError, type Caller, type InviteView, type UserView } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { AuditPort } from "../audit/index.ts";
import type { AuthUserRow, InviteView as InviteRow, Invites } from "../auth/index.ts";
import type { DeleteCascade } from "./delete.ts";
import type { Disabling } from "./disable.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Invitations waiting at once: a link is a standing offer to join, so the owner's list stays one they can read. */
export const MAX_PENDING_INVITES = 50;

export interface UsersService {
  /** Usage only, never content: no session title, project name or file of a user is read. */
  list(): { users: UserView[]; invites: InviteView[] };
  /** `limit_reached` past 50 waiting invitations; the link holds the token and is shown once. */
  invite(
    caller: Caller,
    nameHint: string | null,
    origin: string,
  ): { url: string; expiresAt: number; invite: InviteView };
  revokeInvite(caller: Caller, inviteId: string): void;
  /** `forbidden` for the owner (no cap), `not_found` for an id nothing holds. */
  setBudget(caller: Caller, userId: string, dailyBudgetUsd: number): void;
  /** Disable revokes first, then stops the machines; enable asks the step-up and restores no credential. */
  setDisabled(caller: Caller, userId: string, disabled: boolean): Promise<void>;
  /**
   * Step-up first, then the account is disabled and its machines stopped, then everything the member owns goes (the cascade),
   * the `users` row last. `forbidden` for the owner, `not_found` for an id nothing holds. A failure anywhere leaves a disabled
   * account, never an enabled half-deleted one, and the owner can ask again.
   */
  delete(caller: Caller, userId: string): Promise<void>;
}

export interface UsersDeps {
  readonly clock: Pick<Clock, "now">;
  readonly audit: Pick<AuditPort, "append">;
  readonly auth: {
    roleOf(userId: string): AuthUserRow["role"] | null;
    users(): AuthUserRow[];
    setBudget(userId: string, usd: number | null): void;
    setDisabled(userId: string, disabled: boolean): void;
    readonly invites: Pick<Invites, "create" | "pending" | "revoke">;
  };
  requireStepUp(caller: Caller, now: number): void;
  /** A member's cap in USD; null for the owner. */
  capOf(userId: string): number | null;
  readonly usage: {
    /** The member line of today: API or unknown-billed runs in the owner's zone. */
    spentToday(userId: string): number;
    spentSince(userId: string, since: number): number;
    boxesRunning(userId: string): number;
  };
  readonly disabling: Disabling;
  readonly cascade: DeleteCascade;
  /** Every box's relay policy is pushed again: a budget or a disable shows at once. */
  refreshPolicies(): void;
}

export function createUsersService(deps: UsersDeps): UsersService {
  const { auth } = deps;
  const record = (caller: Caller, reason: string, detail: Record<string, string | number | boolean | null>) =>
    deps.audit.append({
      ownerId: caller.userId,
      actor: "user",
      actorId: caller.userId,
      kind: "auth",
      reason,
      detail,
    });
  const viewOf = (row: AuthUserRow, now: number): UserView => ({
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    disabled: row.disabledAt !== null,
    budgetUsd: deps.capOf(row.id),
    spentTodayUsd: deps.usage.spentToday(row.id),
    spent7dUsd: deps.usage.spentSince(row.id, now - 7 * DAY_MS),
    boxesRunning: deps.usage.boxesRunning(row.id),
  });
  const inviteView = (row: InviteRow): InviteView => ({
    id: row.id,
    nameHint: row.nameHint,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  });
  const target = (userId: string) => {
    const role = auth.roleOf(userId);
    if (role === null) throw new PapError("not_found");
    return role;
  };
  return {
    list() {
      const now = deps.clock.now();
      return {
        users: auth.users().map((row) => viewOf(row, now)),
        invites: auth.invites.pending().map(inviteView),
      };
    },
    invite(caller, nameHint, origin) {
      deps.requireStepUp(caller, deps.clock.now());
      if (auth.invites.pending().length >= MAX_PENDING_INVITES) throw new PapError("limit_reached");
      const made = auth.invites.create(caller.userId, nameHint, origin);
      return { ...made, invite: inviteView(made.invite) };
    },
    revokeInvite(caller, inviteId) {
      if (!auth.invites.revoke(inviteId)) throw new PapError("not_found");
      record(caller, "invite_revoked", { inviteId });
    },
    setBudget(caller, userId, dailyBudgetUsd) {
      if (target(userId) === "owner") throw new PapError("forbidden");
      auth.setBudget(userId, dailyBudgetUsd);
      record(caller, "budget_set", { userId, dailyBudgetUsd });
      deps.refreshPolicies();
    },
    async setDisabled(caller, userId, disabled) {
      if (target(userId) === "owner") throw new PapError("forbidden");
      if (!disabled) deps.requireStepUp(caller, deps.clock.now());
      auth.setDisabled(userId, disabled);
      record(caller, disabled ? "user_disabled" : "user_enabled", { userId });
      // The relay answers `paused` (or the member's own policy again) before the machines are stopped.
      deps.refreshPolicies();
      if (disabled) await deps.disabling.stopAll(userId);
    },
    async delete(caller, userId) {
      deps.requireStepUp(caller, deps.clock.now());
      if (target(userId) === "owner") throw new PapError("forbidden");
      const username = auth.users().find((row) => row.id === userId)?.username ?? null;
      // The disable path first (RT-12d): from here on a crash leaves a disabled account.
      auth.setDisabled(userId, true);
      record(caller, "user_disabled", { userId, byDelete: true });
      deps.refreshPolicies();
      await deps.disabling.stopAll(userId);
      await deps.cascade.run(userId);
      record(caller, "user_deleted", { userId, username });
    },
  };
}
