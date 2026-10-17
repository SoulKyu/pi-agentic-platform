import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { Inbox } from "../inbox/index.ts";
import { isInstalled, mem0Dir } from "./mem0-files.ts";
import { createReview } from "./review.ts";
import { type MemoryRpc, memoryRpc } from "./rpc.ts";
import { createMemoryService } from "./service.ts";

export type { MemoryRpc } from "./rpc.ts";

/** What the memory module reads of the daemon; `composeM11` hands its own core and modules over. */
export interface MemoryModuleDeps {
  readonly core: {
    readonly config: { readonly piAgentDir: string };
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly readOnly: boolean;
  };
  readonly audit: { readonly port: Pick<AuditPort, "append"> };
  readonly inbox: {
    readonly agentItems: Pick<Inbox["agentItems"], "upsertAgentItem" | "resolveRef" | "openRefs">;
  };
  /** The agents module: the registry's port, and the link quarantine's memory step calls. */
  readonly agents: {
    readonly port: {
      get(ownerId: string, agentId: string): unknown;
      list(ownerId: string): ReadonlyArray<{ readonly id: string; readonly name: string }>;
      ownerOf(agentId: string): string | null;
    };
    setLinks(links: { readonly memory: { moveStaged(ownerId: string, agentId: string): number } }): void;
  };
}

/**
 * M11b's memory module (Task 32, ADR 0052): pi-mem0's files are the only contract (`PI_MEM0_DIR` or `<Pi agent dir>/mem0`).
 * It starts the review queue's timer, binds quarantine's memory step and answers the `memory.*` methods. A missing
 * pi-mem0 folder is a status, never a failure.
 */
export function createMemoryModule(deps: MemoryModuleDeps) {
  const { core } = deps;
  const logger = core.logger.child({ module: "memory" });
  const dir = mem0Dir(core.env ?? process.env, core.config.piAgentDir, () =>
    logger.warn("memory_pi_mem0_dir_not_absolute"),
  );
  const review = createReview({
    dir,
    clock: core.clock,
    logger,
    readOnly: core.readOnly,
    ownerOf: deps.agents.port.ownerOf,
    inbox: deps.inbox.agentItems,
  });
  const service = createMemoryService({
    dir,
    clock: core.clock,
    logger,
    readOnly: core.readOnly,
    audit: deps.audit.port,
    inbox: deps.inbox.agentItems,
    agents: deps.agents.port,
  });
  deps.agents.setLinks({ memory: { moveStaged: review.moveStaged } });
  review.start();
  if (!isInstalled(dir)) logger.info("memory_pi_mem0_not_installed");
  return { rpc: memoryRpc(service) satisfies MemoryRpc, stop: review.stop };
}
