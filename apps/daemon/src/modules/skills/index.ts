import type { Clock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { PiWriteQueue } from "../../kernel/pi-write-queue.ts";
import type { ProjectsPort } from "../projects/index.ts";
import { type SkillsRpc, skillsRpc } from "./rpc.ts";
import { createSkillsService } from "./service.ts";

export interface SkillsModule {
  readonly rpc: SkillsRpc;
}

export function createSkillsModule(deps: {
  readonly helpers: HelperPool;
  readonly projects: Pick<ProjectsPort, "covers">;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly writes: PiWriteQueue;
}): SkillsModule {
  return {
    rpc: skillsRpc(createSkillsService({ ...deps, logger: deps.logger.child({ module: "skills" }) })),
  };
}
