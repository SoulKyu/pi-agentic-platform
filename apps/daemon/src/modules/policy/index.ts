import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { type PolicyRpc, policyRpc } from "./rpc.ts";
import { createPolicyService, type PolicyPort } from "./service.ts";
import { createPolicyStore } from "./store.ts";

export type { PolicyPort };

export const POLICY_MIGRATIONS: MigrationSource = {
  module: "policy",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface PolicyModule {
  readonly rpc: PolicyRpc;
  readonly port: PolicyPort;
}

export function createPolicyModule(deps: {
  db: Db;
  clock: Clock;
  logger: Logger;
  newId(): string;
}): PolicyModule {
  const service = createPolicyService({
    store: createPolicyStore(deps.db),
    clock: deps.clock,
    logger: deps.logger.child({ module: "policy" }),
    newId: deps.newId,
  });
  return {
    rpc: policyRpc(service),
    port: {
      scopeOf: service.scopeOf,
      rulesFor: service.rulesFor,
      addAlways: service.addAlways,
      onChange: service.onChange,
    },
  };
}
