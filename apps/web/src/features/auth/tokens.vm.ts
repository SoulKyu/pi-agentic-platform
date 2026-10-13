import { TOKEN_PERMISSIONS } from "@pap/contracts";

type TokenPermissionName = (typeof TOKEN_PERMISSIONS)[number];
export type GridRow = {
  readonly domain: string;
  readonly levels: ReadonlyArray<{ readonly permission: TokenPermissionName; readonly label: string }>;
};

/** Domains × levels, from what a token may hold: no `auth` row, and the policy row has no admin cell (owner Q7 b). */
export function permissionGrid(): GridRow[] {
  const rows: Array<{ domain: string; levels: Array<{ permission: TokenPermissionName; label: string }> }> =
    [];
  for (const permission of TOKEN_PERMISSIONS) {
    const [domain = "", label = ""] = permission.split(":");
    const row = rows.find((candidate) => candidate.domain === domain);
    if (row) row.levels.push({ permission, label });
    else rows.push({ domain, levels: [{ permission, label }] });
  }
  return rows;
}

/** Permissions that act in the owner's name, which the create form warns about. */
export function riskyPermissions(selected: readonly string[]): Array<"sessions:operate"> {
  return selected.includes("sessions:operate") ? ["sessions:operate"] : [];
}

export const isExpired = (expiresAt: number, now: number): boolean => expiresAt <= now;
