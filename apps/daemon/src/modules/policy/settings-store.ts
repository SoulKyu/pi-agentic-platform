import type { Db } from "../../kernel/db/database.ts";

export interface PolicySettingsRow {
  readonly value: string;
  readonly revision: number;
}

export function createSettingsPolicyStore(db: Db) {
  return {
    get: (ownerId: string): PolicySettingsRow | undefined =>
      db.get<PolicySettingsRow>("SELECT value, revision FROM policy_settings WHERE owner_id = $ownerId", {
        ownerId,
      }),
    /**
     * Compare-and-set in one statement: writes only when the stored revision is `baseRevision` (0 = no document yet)
     * and returns the new revision, or null when the document moved or appeared meanwhile (nothing is written then).
     */
    put: (ownerId: string, value: string, baseRevision: number, now: number): number | null =>
      (baseRevision === 0
        ? db.get<{ revision: number }>(
            "INSERT INTO policy_settings (owner_id, value, revision, updated_at) VALUES ($ownerId, $value, 1, $now) " +
              "ON CONFLICT (owner_id) DO NOTHING RETURNING revision",
            { ownerId, value, now },
          )
        : db.get<{ revision: number }>(
            "UPDATE policy_settings SET value = $value, revision = revision + 1, updated_at = $now " +
              "WHERE owner_id = $ownerId AND revision = $baseRevision RETURNING revision",
            { ownerId, value, now, baseRevision },
          )
      )?.revision ?? null,
  };
}
export type SettingsPolicyStore = ReturnType<typeof createSettingsPolicyStore>;
