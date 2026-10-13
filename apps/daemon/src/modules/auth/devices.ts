import { MAX_DEVICES_LISTED, PapError, type Caller, type DeviceView } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import type { AuditPort } from "../audit/index.ts";
import { deviceLabel } from "./device-label.ts";
import { requirePermission, requireSessionAdmin } from "./guards.ts";
import type { AuthService } from "./service.ts";
import type { AuthStore } from "./store.ts";

export interface DeviceDeps {
  readonly store: Pick<AuthStore, "listDevices" | "deleteExpiredSessions">;
  readonly service: Pick<AuthService, "revokeDevice" | "revokeOtherDevices">;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
}

export function createDevices(deps: DeviceDeps) {
  return {
    list(caller: Caller): DeviceView[] {
      requirePermission(caller, "auth:read");
      try {
        deps.store.deleteExpiredSessions(deps.clock.now());
      } catch (error) {
        // A read still answers on a read-only database (R130): the expired rows are not shown either way.
        if (!isReadOnlyError(error)) throw error;
      }
      const now = deps.clock.now();
      return deps.store
        .listDevices(caller.userId, MAX_DEVICES_LISTED)
        .filter((row) => row.expiresAt > now)
        .map((row) => ({
          id: row.publicId,
          current: row.publicId === caller.credentialId,
          ...deviceLabel(row.userAgent),
          ip: row.ip,
          method: row.method,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          expiresAt: row.expiresAt,
        }));
    },
    /** Another owner's id and an id that never existed answer alike. This browser's own id signs it out. */
    revoke(caller: Caller, deviceId: string): void {
      requireSessionAdmin(caller);
      if (!deps.service.revokeDevice(caller.userId, deviceId)) throw new PapError("not_found");
      deps.audit.append({
        ownerId: caller.userId,
        actor: "user",
        kind: "auth",
        reason: "device_revoked",
        detail: { deviceId },
      });
    },
    revokeOthers(caller: Caller): { revoked: number } {
      requireSessionAdmin(caller);
      const revoked = deps.service.revokeOtherDevices(caller.userId, caller.credentialId);
      deps.audit.append({
        ownerId: caller.userId,
        actor: "user",
        kind: "auth",
        reason: "devices_revoked",
        detail: { count: revoked },
      });
      return { revoked };
    },
  };
}

export type Devices = ReturnType<typeof createDevices>;
