import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { type PolicyRpc, type PolicyV2Rpc, policyRpc, policyV2Rpc } from "./rpc.ts";
import { createPolicyService, type PolicyPort } from "./service.ts";
import { createSessionPolicyService } from "./session-service.ts";
import { createSessionPolicyStore } from "./session-store.ts";
import { createSettingsPolicyStore } from "./settings-store.ts";
import { createPolicyStore } from "./store.ts";

export { RESTRICTIVE_SETTINGS } from "./session-service.ts";
export type { PolicyPort };

export const POLICY_MIGRATIONS: MigrationSource = {
  module: "policy",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface PolicyModule {
  readonly rpc: PolicyRpc & PolicyV2Rpc;
  readonly port: PolicyPort;
}

export function createPolicyModule(deps: {
  db: Db;
  clock: Clock;
  logger: Logger;
  newId(): string;
  readonly audit: AuditPort;
  /** Who owns a session. The sessions module is built after this one, so the composition binds it late (M5R56). */
  sessionOwner(sessionId: string): string | null;
}): PolicyModule {
  const logger = deps.logger.child({ module: "policy" });
  const service = createPolicyService({
    store: createPolicyStore(deps.db),
    clock: deps.clock,
    logger,
    newId: deps.newId,
  });
  const sessionPolicy = createSessionPolicyService({
    sessions: createSessionPolicyStore(deps.db),
    settings: createSettingsPolicyStore(deps.db),
    clock: deps.clock,
    logger,
    audit: deps.audit,
    sessionOwner: deps.sessionOwner,
  });
  return {
    rpc: { ...policyRpc(service), ...policyV2Rpc(sessionPolicy) },
    port: {
      scopeOf: service.scopeOf,
      rulesFor: service.rulesFor,
      addAlways: service.addAlways,
      onChange: service.onChange,
      sessionPolicy: sessionPolicy.sessionPolicy,
      settings: sessionPolicy.settings,
      markTainted: sessionPolicy.markTainted,
      inherit: sessionPolicy.inherit,
      onSessionChange: sessionPolicy.onSessionChange,
      onSettingsChange: sessionPolicy.onSettingsChange,
    },
  };
}
