import type { Hono } from "hono";
import type { AgentFilesSource } from "../../kernel/agent-path.ts";
import type { BoxOps, ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import type { BoundaryConfig } from "../../kernel/fs/boundary.ts";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import { mountAttachmentsRoute } from "./attachments-http.ts";
import { type AttachmentsPort, createAttachmentsStore } from "./attachments-store.ts";
import { mountRawRoute } from "./raw-http.ts";
import { filesRpc, type FilesRpc } from "./rpc.ts";
import { createFilesService } from "./service.ts";
import { mountUploadRoute } from "./upload-http.ts";

export type { FilesRpc };
export type { AttachmentsPort } from "./attachments-store.ts";
export { cleanupAttachments } from "./attachments-cleanup.ts";
export { createInflight } from "./inflight.ts";
export { receiveBody } from "./receive-body.ts";
export { refuse } from "./upload-http.ts";

export interface FilesModule {
  readonly rpc: FilesRpc;
  /** Claims of pending uploads per session (M8R39); used by the sessions module (Task 8). */
  readonly attachments: AttachmentsPort;
  /** The raw file routes (`GET` and `PUT /files/raw`) and `POST /upload`, cookie-only. */
  mount(app: Hono, caller: HttpCaller): void;
  /** Drops the cached indexes and stops the attachments sweep. */
  shutdown(): void;
}

export function createFilesModule(deps: {
  roots(ownerId: string): readonly string[];
  readonly boundary: BoundaryConfig;
  readonly deny: DenySet;
  readonly git: GitRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  readonly workerUmask: number;
  /** `$PAP_HOME/attachments`: pending uploads and the copies claimed per session (M8R36). */
  readonly attachmentsDir: string;
  /** Late-bound (J1 wires them): with no source bound, every path is a host path. */
  readonly boxes?: () => ProjectBoxSource | undefined;
  readonly boxOps?: () => BoxOps | undefined;
  /** Late-bound: the agents' VMs and where their folders are (`/agents/<id>`); with none, `/agents` answers `not_found`. */
  readonly agentOps?: () => BoxOps | undefined;
  readonly agents?: () => AgentFilesSource | undefined;
  readonly isMember: (userId: string) => boolean;
}): FilesModule {
  const logger = deps.logger.child({ module: "files" });
  const service = createFilesService({ ...deps, logger });
  const store = createAttachmentsStore({
    dir: deps.attachmentsDir,
    clock: deps.clock,
    logger,
    deny: deps.deny,
  });
  return {
    rpc: filesRpc(service),
    attachments: store,
    mount: (app, caller) => {
      mountRawRoute(app, { caller, service, logger });
      mountUploadRoute(app, { caller, service, logger });
      mountAttachmentsRoute(app, { caller, store, logger, readOnly: deps.readOnly });
    },
    shutdown: () => {
      service.index.clear();
      store.stop();
    },
  };
}
