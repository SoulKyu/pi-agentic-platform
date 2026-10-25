import type { Role } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";

/** How a provider is signed in, by the relay's own rule: `checkAuth().type`. A subscription (oauth) is never served to a box. */
export type AuthKind = "api_key" | "oauth";

/** The Claude bridge has no stored auth: it is gated by the box owner's own token, never by sharing. */
const BRIDGE = "claude-bridge";
export const isSharingExempt = (provider: string): boolean => provider === BRIDGE;

export interface ProviderSharing {
  /**
   * Whether `userId` may use `provider`. The owner always may, an unknown id never, the bridge always. A member needs the
   * provider's row, written here on first sight (shared when `auth` is `api_key`, else not); a provider with no known auth
   * and no row is not shared and leaves no row. A subscription provider is never shared, whatever its row says.
   */
  sharedFor(userId: string, provider: string, auth: AuthKind | null): boolean;
  /** The provider's switch as the owner sees it: the row, written on first sight like `sharedFor`. */
  stateOf(provider: string, auth: AuthKind | null): boolean;
  list(): Array<{ provider: string; shared: boolean }>;
  set(provider: string, shared: boolean): void;
}

export function createProviderSharing(deps: {
  readonly db: Db;
  readonly roleOf: (userId: string) => Role | null;
}): ProviderSharing {
  const { db } = deps;
  const read = (provider: string): boolean | null => {
    const row = db.get<{ shared: number }>("SELECT shared FROM provider_sharing WHERE provider = $provider", {
      provider,
    });
    return row === undefined ? null : row.shared === 1;
  };
  const write = (provider: string, shared: boolean, replace: boolean): void => {
    const sql = replace
      ? "INSERT INTO provider_sharing (provider, shared) VALUES ($provider, $shared) ON CONFLICT (provider) DO UPDATE SET shared = excluded.shared"
      : "INSERT OR IGNORE INTO provider_sharing (provider, shared) VALUES ($provider, $shared)";
    db.run(sql, { provider, shared: shared ? 1 : 0 });
  };
  const stateOf = (provider: string, auth: AuthKind | null): boolean => {
    const stored = read(provider);
    if (stored !== null) return stored;
    if (auth === null) return false;
    const shared = auth === "api_key";
    try {
      write(provider, shared, false);
    } catch (error) {
      if (!isReadOnlyError(error)) throw error;
    }
    return shared;
  };
  return {
    sharedFor(userId, provider, auth) {
      const role = deps.roleOf(userId);
      if (role === null) return false;
      if (role === "owner" || isSharingExempt(provider)) return true;
      const shared = stateOf(provider, auth);
      return auth === "api_key" && shared;
    },
    stateOf,
    list: () =>
      db
        .all<{ provider: string; shared: number }>(
          "SELECT provider, shared FROM provider_sharing ORDER BY provider",
        )
        .map((row) => ({ provider: row.provider, shared: row.shared === 1 })),
    set: (provider, shared) => write(provider, shared, true),
  };
}
