import { freemem } from "node:os";
import type { BoxControl, BoxTerminals, ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { BoundaryConfig } from "../../kernel/fs/boundary.ts";
import type { Logger } from "../../kernel/logger.ts";
import { loadNodePty, type NodePty } from "../../kernel/pty/load.ts";
import type { WorkerScopes } from "../../kernel/supervisor/scope.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { createBoxActivity } from "./box-activity.ts";
import { createLauncher } from "./launch.ts";
import { createTerminalRegistry, type TerminalRegistryDeps } from "./registry.ts";
import { terminalRpc, type TerminalRpc } from "./rpc.ts";
import { createTerminalService } from "./service.ts";

export interface TerminalModuleDeps {
  /** The caller's project roots (M8R15). */
  roots(ownerId: string): readonly string[];
  readonly boundary: BoundaryConfig;
  readonly hub: Pick<StreamHub, "registerSnapshot" | "publish">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly scopes: Pick<WorkerScopes, "next">;
  /** The umask the daemon started with, from `prepareHome` (MC26 I3); never read from the process here. */
  readonly workerUmask: number;
  readonly maxTerminals: number;
  readonly minFreeMemMb: number;
  /** Defaults to the boot probe's loader. Tests pass a fake `node-pty`, or null. */
  loadPty?(): NodePty | null;
  freeMemMb?(): number;
  /** Lot B2: the owner's box projects, their control and their ptys; a box terminal also keeps its box awake for `idleMs`. */
  readonly boxes?: () => ProjectBoxSource | undefined;
  readonly boxControl?: () => BoxControl | undefined;
  readonly boxTerminals?: () => BoxTerminals | undefined;
  /** `PAP_WORKER_IDLE_MINUTES` in ms: the box idle time a terminal in use pushes back; 0 never idles. */
  readonly idleMs?: number;
  kill?: TerminalRegistryDeps["kill"];
  alive?: TerminalRegistryDeps["alive"];
}

export interface TerminalModule {
  readonly rpc: TerminalRpc;
  /** The owner's running terminals in a folder or below (lanes: archive refuses while one runs). */
  runningIn(ownerId: string, folder: string): number;
  /** Every terminal climbs the kill ladder in parallel, then the scope reap (M8R66). */
  shutdown(): Promise<void>;
}

const MIB = 1024 * 1024;

export function createTerminalModule(deps: TerminalModuleDeps): TerminalModule {
  const logger = deps.logger.child({ module: "terminal" });
  const registry = createTerminalRegistry({
    clock: deps.clock,
    logger,
    maxTerminals: deps.maxTerminals,
    minFreeMemMb: deps.minFreeMemMb,
    freeMemMb: deps.freeMemMb ?? (() => freemem() / MIB),
    launch: createLauncher({
      env: deps.env,
      scopes: deps.scopes,
      workerUmask: deps.workerUmask,
      logger,
      loadPty: deps.loadPty ?? (() => loadNodePty(logger)),
    }),
    ...(deps.kill ? { kill: deps.kill } : {}),
    ...(deps.alive ? { alive: deps.alive } : {}),
  });
  const boxActivity = createBoxActivity({
    clock: deps.clock,
    idleMs: deps.idleMs ?? 0,
    registry,
    touch: (projectId) => deps.boxTerminals?.()?.touch(projectId),
  });
  const service = createTerminalService({
    roots: deps.roots,
    boundary: deps.boundary,
    registry,
    hub: deps.hub,
    logger,
    maxTerminals: deps.maxTerminals,
    clock: deps.clock,
    ...(deps.boxes ? { boxes: deps.boxes } : {}),
    ...(deps.boxControl ? { boxControl: deps.boxControl } : {}),
    ...(deps.boxTerminals ? { boxTerminals: deps.boxTerminals } : {}),
    boxActivity,
  });
  return {
    rpc: terminalRpc(service),
    runningIn: registry.runningIn,
    shutdown: async () => {
      boxActivity.stop();
      await registry.closeAll();
    },
  };
}
