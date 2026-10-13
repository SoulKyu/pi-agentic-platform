import { PapError, type Caller, type Permission } from "@pap/contracts";

export function requirePermission(caller: Caller, permission: Permission): void {
  if (!caller.permissions.has(permission)) throw new PapError("forbidden");
}

// Only a browser session can sign browsers out or remove a credential: a token caller (which never holds auth:*)
// must not get there by any route, and a device's "the others" are measured against its own session id.
export function requireSessionAdmin(caller: Caller): void {
  requirePermission(caller, "auth:admin");
  if (caller.kind !== "session") throw new PapError("forbidden");
}
