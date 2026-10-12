import type { Db } from "../../kernel/db/database.ts";

export interface SettingRow {
  readonly value: string;
  readonly revision: number;
}

export interface SettingsStore {
  get(ownerId: string, key: string): SettingRow | undefined;
  /**
   * Compare-and-set in one statement: writes only when the stored revision is `baseRevision` (0 = no document yet)
   * and returns the new revision, or null when the document moved or appeared meanwhile (nothing is written then).
   */
  put(ownerId: string, key: string, value: string, baseRevision: number, now: number): number | null;
}

export function createSettingsStore(db: Db): SettingsStore {
  return {
    get: (ownerId, key) =>
      db.get<SettingRow>("SELECT value, revision FROM settings WHERE owner_id = $ownerId AND key = $key", {
        ownerId,
        key,
      }),
    put: (ownerId, key, value, baseRevision, now) =>
      (baseRevision === 0
        ? db.get<{ revision: number }>(
            "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ($ownerId, $key, $value, 1, $now) " +
              "ON CONFLICT (owner_id, key) DO NOTHING RETURNING revision",
            { ownerId, key, value, now },
          )
        : db.get<{ revision: number }>(
            "UPDATE settings SET value = $value, revision = revision + 1, updated_at = $now " +
              "WHERE owner_id = $ownerId AND key = $key AND revision = $baseRevision RETURNING revision",
            { ownerId, key, value, now, baseRevision },
          )
      )?.revision ?? null,
  };
}
