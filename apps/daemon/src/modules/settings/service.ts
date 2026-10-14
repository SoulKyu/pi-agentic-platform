import {
  MAX_SETTING_BYTES,
  ModelsSettings,
  PapError,
  type Caller,
  type SettingKey,
  type SettingWrite,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { SettingsStore } from "./store.ts";

/** What other modules read of the owner's settings. */
export interface SettingsPort {
  /** The owner's Models settings; a missing or damaged row reads as the defaults, so the lookup is off (M7R138). */
  models(ownerId: string): ModelsSettings;
}

export interface SettingsService extends SettingsPort {
  get(caller: Caller, key: SettingKey): { value: unknown; revision: number };
  set(caller: Caller, write: SettingWrite): { revision: number };
}

export function createSettingsService(deps: {
  readonly store: SettingsStore;
  readonly clock: Clock;
  readonly logger: Logger;
}): SettingsService {
  function read(ownerId: string, key: SettingKey): { value: unknown; revision: number } {
    const row = deps.store.get(ownerId, key);
    if (!row) return { value: null, revision: 0 };
    try {
      return { value: JSON.parse(row.value) as unknown, revision: row.revision };
    } catch {
      // A damaged row reads as no setting: the client falls back to its defaults and the next write replaces it.
      deps.logger.warn("settings_row_unreadable", { key });
      return { value: null, revision: row.revision };
    }
  }
  return {
    get: (caller, key) => read(caller.userId, key),
    models(ownerId) {
      const parsed = ModelsSettings.safeParse(read(ownerId, "models").value ?? {});
      if (parsed.success) return parsed.data;
      deps.logger.warn("settings_row_unreadable", { key: "models" });
      return ModelsSettings.parse({});
    },
    set(caller, write) {
      const text = JSON.stringify(write.value);
      if (Buffer.byteLength(text, "utf8") > MAX_SETTING_BYTES) throw new PapError("payload_too_large");
      // Compare-and-set (owner R3-4): a write based on a revision that moved never lands over the newer copy.
      const revision = deps.store.put(caller.userId, write.key, text, write.baseRevision, deps.clock.now());
      if (revision === null) throw new PapError("conflict");
      return { revision };
    },
  };
}
