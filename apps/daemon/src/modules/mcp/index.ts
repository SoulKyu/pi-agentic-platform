import type { Clock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { PiWriteQueue } from "../../kernel/pi-write-queue.ts";
import type { ProjectsPort } from "../projects/index.ts";
import { type McpRpc, mcpRpc } from "./rpc.ts";
import { createMcpService } from "./service.ts";

export interface McpModule {
  readonly rpc: McpRpc;
}

export function createMcpModule(deps: {
  readonly helpers: HelperPool;
  readonly projects: Pick<ProjectsPort, "covers">;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly writes: PiWriteQueue;
  /** How long a Test waits for the server to connect; tests shorten the 20 s default. */
  readonly testDeadlineMs?: number;
}): McpModule {
  return { rpc: mcpRpc(createMcpService({ ...deps, logger: deps.logger.child({ module: "mcp" }) })) };
}
