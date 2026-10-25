import { PapError, type InviteInfo } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { newId, randomToken, sha256Hex } from "../../kernel/ids.ts";
import type { AuditPort } from "../audit/index.ts";
import type { InviteRow, InviteStore } from "./invite-store.ts";
import { hashPassword } from "./passwords.ts";
import type { AuthStore } from "./store.ts";

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** An invitation as the owner's list reads it: never the token, never its hash. */
export type InviteView = InviteRow;

export interface Invites {
  /** The link is `<origin>/invite#token=<token>`; the origin is the caller's when allowed, else the public one. */
  create(
    createdBy: string,
    nameHint: string | null,
    origin: string,
  ): { url: string; expiresAt: number; invite: InviteView };
  /** Unused and unexpired. */
  pending(): InviteView[];
  revoke(id: string): boolean;
  /** Who invited, for the page before its form; null when the invitation does not work. */
  info(token: string): InviteInfo | null;
  /**
   * Marks the invitation used and creates the member in one transaction. `invite_invalid` when it does not work
   * (unknown, used, expired, revoked, lost a race); `username_taken` rolls the use back, so it stays usable.
   */
  accept(input: { token: string; username: string; password: string }): Promise<{ userId: string }>;
}

export interface InvitesDeps {
  readonly db: Db;
  readonly store: InviteStore;
  readonly users: Pick<AuthStore, "insertMember">;
  readonly clock: Clock;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly audit: Pick<AuditPort, "append">;
}

export function createInvites(deps: InvitesDeps): Invites {
  return {
    create(createdBy, nameHint, origin) {
      const token = randomToken(32);
      const now = deps.clock.now();
      const invite: InviteView = {
        id: newId(),
        createdBy,
        nameHint,
        createdAt: now,
        expiresAt: now + INVITE_TTL_MS,
      };
      deps.store.insert({ ...invite, tokenHash: sha256Hex(token) });
      deps.audit.append({
        ownerId: createdBy,
        actor: "user",
        kind: "auth",
        reason: "user_invited",
        detail: { inviteId: invite.id },
      });
      const base = deps.allowedOrigins.has(origin) ? origin : deps.publicOrigin;
      return { url: `${base}/invite#token=${token}`, expiresAt: invite.expiresAt, invite };
    },
    pending: () => deps.store.listLive(deps.clock.now()),
    revoke: (id) => deps.store.revoke(id),
    info(token) {
      const live = deps.store.findLive(sha256Hex(token), deps.clock.now());
      return live ? { inviter: live.inviter, expiresAt: live.expiresAt } : null;
    },
    async accept(input) {
      const tokenHash = sha256Hex(input.token);
      const live = deps.store.findLive(tokenHash, deps.clock.now());
      if (!live) throw new PapError("invite_invalid");
      const passwordHash = await hashPassword(input.password);
      const id = newId();
      deps.db.transaction(() => {
        const now = deps.clock.now();
        if (!deps.store.markUsed(tokenHash, now, id)) throw new PapError("invite_invalid");
        if (!deps.users.insertMember({ id, username: input.username, passwordHash, createdAt: now })) {
          throw new PapError("username_taken");
        }
      });
      deps.audit.append({
        ownerId: live.createdBy,
        actor: "user",
        kind: "auth",
        reason: "member_created",
        detail: { inviteId: live.id, memberId: id },
      });
      return { userId: id };
    },
  };
}
