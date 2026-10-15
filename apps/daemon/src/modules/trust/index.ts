import type { Clock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { SessionsModule } from "../sessions/index.ts";
import { type TrustRpc, trustRpc } from "./rpc.ts";
import { createTrustService, type TrustPort } from "./service.ts";

export type { TrustPort };

export interface TrustModule {
  readonly rpc: TrustRpc;
  /** Internal: no RPC, no step-up. Every write is audited (M9R39). */
  readonly port: TrustPort;
}

export function createTrustModule(deps: {
  readonly helpers: HelperPool;
  readonly projects: Pick<ProjectsPort, "covers" | "roots">;
  readonly sessions: Pick<SessionsModule, "restartFolder">;
  readonly audit: Pick<AuditPort, "append">;
  readonly logger: Logger;
  readonly clock: Clock;
}): TrustModule {
  const service = createTrustService({ ...deps, logger: deps.logger.child({ module: "trust" }) });
  return { rpc: trustRpc(service), port: service.port };
}
