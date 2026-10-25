import { methods, permissionsOf, TOKEN_PERMISSIONS, type Role } from "@pap/contracts";

type TokenPermissionName = (typeof TOKEN_PERMISSIONS)[number];
export type GridRow = {
  readonly domain: string;
  readonly levels: ReadonlyArray<{ readonly permission: TokenPermissionName; readonly label: string }>;
};

/**
 * Domains × levels: what a token may hold (`TOKEN_PERMISSIONS`: no `auth` row, no policy or pi admin, no terminal) that
 * some method declares, so a cell never grants what nothing checks (M7R124). The catalogue is the contracts' own; a
 * new method brings its permission into the grid with no list to edit.
 */
export function permissionGrid(
  catalogue: ReadonlyArray<{ readonly permission: string }> = Object.values(methods),
  role: Role = "owner",
): GridRow[] {
  const held = permissionsOf(role);
  const used = new Set<string>(catalogue.map((method) => method.permission));
  const rows: Array<{ domain: string; levels: Array<{ permission: TokenPermissionName; label: string }> }> =
    [];
  for (const permission of TOKEN_PERMISSIONS) {
    // A token never holds more than its creator (RT-20): a member is offered no pi or system permission.
    if (!used.has(permission) || !held.has(permission)) continue;
    const [domain = "", label = ""] = permission.split(":");
    const row = rows.find((candidate) => candidate.domain === domain);
    if (row) row.levels.push({ permission, label });
    else rows.push({ domain, levels: [{ permission, label }] });
  }
  return rows;
}

/** Permissions that act in the owner's name, which the create form warns about. */
const RISKY = ["sessions:operate", "files:read", "files:operate", "automation:operate"] as const;
export type RiskyPermission = (typeof RISKY)[number];
export function riskyPermissions(selected: readonly string[]): RiskyPermission[] {
  return RISKY.filter((permission) => selected.includes(permission));
}

export const isExpired = (expiresAt: number, now: number): boolean => expiresAt <= now;
