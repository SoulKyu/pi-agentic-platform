import { PapError } from "@pap/contracts";
import type { BoxControl, BoxOps } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { ProjectsModule } from "../projects/index.ts";
import { createGithubActions, type GithubActionsService } from "./actions.ts";
import { createDelivery, type Delivery } from "./deliver.ts";
import type { GithubCore } from "./index.ts";
import { createKeys, type ProjectKeys } from "./keys.ts";
import { createGithubProjectStore, type GithubProjectStore } from "./project-store.ts";
import { createGithubProjects, type GithubBoxes, type GithubProjectsService } from "./projects.ts";
import type { GithubSessionsPort } from "./send.ts";
import { githubProjectsRpc, type GithubProjectsRpc } from "./projects-rpc.ts";

export interface GithubProjectsDeps {
  /** The database the projects migrations ran on (`project_github` is one of their tables). */
  readonly db: Db;
  readonly audit: Pick<AuditPort, "append">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly projects: Pick<ProjectsModule, "create" | "hasRoom" | "boxSource" | "port">;
  /** `GithubFeature.service.setPermissionMissing(true)`: the key upload was refused for the missing SSH signing keys permission. */
  permissionMissing(): void;
  /** What "send to a session" asks of the sessions and policy modules. */
  readonly sessions: GithubSessionsPort;
}

export interface GithubProjectsFeature {
  readonly service: GithubProjectsService;
  readonly rpc: GithubProjectsRpc;
  readonly keys: ProjectKeys;
  /** The `project_github` rows (the project page and the tests read them). */
  readonly store: GithubProjectStore;
  /** From the composition, once the real box control exists: the delivery loop follows the box phases. Returns its stop. */
  bind(boxes: { control: BoxControl; ops: BoxOps }): () => void;
  /** Starts the daily key sweep and the removal of a deleted project's key; returns the stop. */
  start(): () => void;
}

/** Projects from GitHub, links, tokens to the box and signing keys (B3), on the GitHub core and the projects module. */
export function createGithubProjectsFeature(
  core: GithubCore,
  deps: GithubProjectsDeps,
): GithubProjectsFeature {
  const store = createGithubProjectStore(deps.db);
  const logger = deps.logger.child({ module: "github" });
  const keys = createKeys({
    core,
    store,
    clock: deps.clock,
    logger,
    nameOf: (ownerId, projectId) => deps.projects.port.list(ownerId, [projectId])[0]?.name ?? null,
    permissionMissing: deps.permissionMissing,
  });
  const later: { actions?: GithubActionsService } = {};
  let live: (GithubBoxes & { stop(): void }) | undefined;
  const service = createGithubProjects({
    core,
    store,
    keys,
    projects: deps.projects,
    audit: deps.audit,
    clock: deps.clock,
    logger,
    changed: (projectId) => later.actions?.invalidate(projectId),
    boxes: () => {
      if (live === undefined) throw new PapError("internal");
      return live;
    },
  });
  const built = createGithubActions({
    core,
    store,
    source: deps.projects.boxSource,
    audit: deps.audit,
    clock: deps.clock,
    sessions: deps.sessions,
    baseView: service.view,
    ops: () => {
      if (live === undefined) throw new PapError("internal");
      return live.ops;
    },
  });
  later.actions = built;
  return {
    service,
    rpc: githubProjectsRpc(service, built),
    keys,
    store,
    bind(boxes) {
      const delivery: Delivery = createDelivery({
        core,
        store,
        keys,
        control: boxes.control,
        ops: boxes.ops,
        source: deps.projects.boxSource,
        clock: deps.clock,
        logger,
      });
      const stop = delivery.start();
      live = { ...boxes, delivery, stop };
      return () => {
        stop();
        live = undefined;
      };
    },
    start() {
      keys.start();
      const off = deps.projects.port.onRemoved(
        (ownerId, projectId) => void service.removed(ownerId, projectId),
      );
      return () => {
        keys.stop();
        off();
      };
    },
  };
}
