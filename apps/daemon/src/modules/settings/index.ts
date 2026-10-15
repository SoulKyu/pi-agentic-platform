import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { settingsRpc, type SettingsRpc } from "./rpc.ts";
import { createSettingsService, type SettingsPort } from "./service.ts";
import { createSettingsStore } from "./store.ts";

export const SETTINGS_MIGRATIONS: MigrationSource = {
  module: "settings",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export type { SettingsPort } from "./service.ts";

export interface SettingsModule {
  readonly rpc: SettingsRpc;
  readonly port: SettingsPort;
}

export function createSettingsModule(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
}): SettingsModule {
  const logger = deps.logger.child({ module: "settings" });
  const service = createSettingsService({ store: createSettingsStore(deps.db), clock: deps.clock, logger });
  return { rpc: settingsRpc(service), port: { models: service.models, automation: service.automation } };
}
