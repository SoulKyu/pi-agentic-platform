import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { type AuditRpc, auditRpc } from "./rpc.ts";
import { type AuditPort, createAuditService } from "./service.ts";
import { createAuditStore, monthCutoff } from "./store.ts";

export { monthCutoff };
export type { AuditPort };

export const AUDIT_MIGRATIONS: MigrationSource = {
  module: "audit",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

/** What `pap audit prune` needs; it runs while the daemon is stopped (Q5). */
export interface AuditCli {
  monthsBefore(cutoff: string): string[];
  count(month: string): number;
  /** Deletes a whole month older than 12 months and leaves the prune's own line. Returns the rows deleted. */
  prune(month: string): number;
}

export interface AuditModule {
  readonly rpc: AuditRpc;
  readonly port: AuditPort;
  readonly cli: AuditCli;
  /** The months old enough to prune, for the boot message (M5R125); null when there are none. */
  prunableAtBoot(now: number): { months: number; oldest: string } | null;
}

export function createAuditModule(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
}): AuditModule {
  const store = createAuditStore(deps.db);
  const service = createAuditService({
    store,
    clock: deps.clock,
    logger: deps.logger.child({ module: "audit" }),
  });
  return {
    rpc: auditRpc(service),
    port: { append: service.append, fromWorker: service.fromWorker },
    cli: {
      monthsBefore: store.monthsBefore,
      count: store.count,
      prune: (month) => store.prune(month, deps.clock.now()),
    },
    prunableAtBoot(now) {
      const months = store.monthsBefore(monthCutoff(now));
      const oldest = months[0];
      return oldest === undefined ? null : { months: months.length, oldest };
    },
  };
}
