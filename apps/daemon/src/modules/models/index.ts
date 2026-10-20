import type { AvailableModels, Caller, ModelsOverview } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { PiWriteQueue } from "../../kernel/pi-write-queue.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { AuditPort } from "../audit/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { SettingsPort } from "../settings/index.ts";
import { type ModelsRpc, modelsRpc } from "./rpc.ts";
import { createModelsService } from "./service.ts";

export { createModelsService } from "./service.ts";
export { sweepValidationCopies } from "./sweep.ts";

/** What other modules ask of models (the model menu of Task 29 reads the same overview). */
export interface ModelsPort {
  overview(caller: Caller, cwd?: string): Promise<ModelsOverview>;
  /** The models Pi would let a session use (the agent form's picker): what the VM relay allows an agent (R13). */
  available(caller: Caller, cwd?: string): Promise<AvailableModels>;
  /** After a write of Pi's files cleared the `models.available` cache (ADR 0068). */
  onChanged(listener: () => void): void;
}

export interface ModelsModule {
  readonly rpc: ModelsRpc;
  readonly port: ModelsPort;
}

export function createModelsModule(deps: {
  readonly helpers: HelperPool;
  readonly projects: Pick<ProjectsPort, "covers">;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot" | "onLastSubscriberLeft">;
  readonly settings: Pick<SettingsPort, "models">;
  readonly writes: PiWriteQueue;
}): ModelsModule {
  const changed = new Set<() => void>();
  const service = createModelsService({
    ...deps,
    logger: deps.logger.child({ module: "models" }),
    onWrote: () => changed.forEach((listener) => listener()),
  });
  return {
    rpc: modelsRpc(service),
    port: {
      overview: service.overview,
      available: service.available,
      onChanged: (listener) => void changed.add(listener),
    },
  };
}
