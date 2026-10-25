import { join } from "node:path";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Db } from "./kernel/db/database.ts";
import type { Logger } from "./kernel/logger.ts";
import type { AuditModule } from "./modules/audit/index.ts";
import { type AuthModule, createAuthModule } from "./modules/auth/index.ts";

/** The auth module over the daemon's core: where its origin, TLS and secrets settings come from. */
export function composeAuth(
  core: { readonly db: Db; readonly clock: Clock; readonly logger: Logger; readonly config: Config },
  audit: Pick<AuditModule, "port">,
): AuthModule {
  const { config } = core;
  return createAuthModule({
    db: core.db,
    clock: core.clock,
    logger: core.logger,
    publicOrigin: config.publicOrigin,
    allowedOrigins: config.allowedOrigins,
    insecureHttp: config.insecureHttp,
    audit: audit.port,
    secretsDir: join(config.home, "secrets"),
  });
}
