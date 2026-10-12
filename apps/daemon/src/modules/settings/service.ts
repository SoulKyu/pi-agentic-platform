import { MAX_SETTING_BYTES, PapError, type Caller, type SettingKey, type SettingWrite } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { SettingsStore } from "./store.ts";

export interface SettingsService {
  get(caller: Caller, key: SettingKey): { value: unknown; revision: number };
  set(caller: Caller, write: SettingWrite): { revision: number };
}

export function createSettingsService(deps: {
  readonly store: SettingsStore;
  readonly clock: Clock;
  readonly logger: Logger;
}): SettingsService {
  return {
    get(caller, key) {
      const row = deps.store.get(caller.userId, key);
      if (!row) return { value: null, revision: 0 };
      try {
        return { value: JSON.parse(row.value) as unknown, revision: row.revision };
      } catch {
        // A damaged row reads as no setting: the client falls back to its defaults and the next write replaces it.
        deps.logger.warn("settings_row_unreadable", { key });
        return { value: null, revision: row.revision };
      }
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
