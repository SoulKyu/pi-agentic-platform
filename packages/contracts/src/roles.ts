import { ALL_PERMISSIONS, type Permission } from "./permissions.ts";

export const ROLES = ["owner", "member"] as const;
export type Role = (typeof ROLES)[number];

/** What a member never holds: pap's administration, Pi's configuration, user management and lanes (M14). */
export function memberDenied(permission: Permission): boolean {
  return (
    permission === "system:admin" ||
    permission.startsWith("pi:") ||
    permission.startsWith("users:") ||
    permission.startsWith("lanes:")
  );
}

const OWNER: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);
const MEMBER: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS.filter((p) => !memberDenied(p)));

export function permissionsOf(role: Role): ReadonlySet<Permission> {
  return role === "owner" ? OWNER : MEMBER;
}
