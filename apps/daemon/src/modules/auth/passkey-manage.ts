import { MAX_PASSKEYS_LISTED, PapError, type Caller, type PasskeyView } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { AuditPort } from "../audit/index.ts";
import { passkeyRefOf } from "./passkey-store.ts";
import { requirePermission, requireSessionAdmin } from "./guards.ts";
import type { AuthService } from "./service.ts";
import { requireStepUp } from "./step-up.ts";
import type { AuthStore } from "./store.ts";

export interface PasskeyManagerDeps {
  readonly store: Pick<AuthStore, "listPasskeyListings">;
  readonly service: Pick<AuthService, "removePasskey">;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
}

export function createPasskeyManager(deps: PasskeyManagerDeps) {
  return {
    list(caller: Caller): PasskeyView[] {
      requirePermission(caller, "auth:read");
      return deps.store.listPasskeyListings(caller.userId, MAX_PASSKEYS_LISTED).map((row) => ({
        id: passkeyRefOf(row.id),
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        transports: row.transports,
      }));
    },
    /**
     * Synchronous on purpose (M5R9): the passkey and the browsers it opened are gone in one step, before the
     * caller's first await. The last passkey can go too; the password stays (M5R76). Another user's id and an id
     * that never existed answer alike, and only after the step-up, so the answer is no existence oracle.
     */
    remove(caller: Caller, passkeyId: string): { revoked: number } {
      requireSessionAdmin(caller);
      requireStepUp(caller, deps.clock.now());
      const removed = deps.service.removePasskey(caller.userId, passkeyId);
      if (!removed) throw new PapError("not_found");
      deps.audit.append({
        ownerId: caller.userId,
        actor: "user",
        kind: "auth",
        reason: "passkey_removed",
        detail: { passkeyId, count: removed.revoked },
      });
      return removed;
    },
  };
}

export type PasskeyManager = ReturnType<typeof createPasskeyManager>;
