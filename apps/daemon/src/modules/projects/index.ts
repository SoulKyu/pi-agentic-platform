import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { projectsRpc, type ProjectsRpc } from "./rpc.ts";
import { createProjectsService, type ProjectView } from "./service.ts";
import { createProjectsStore } from "./store.ts";

export const PROJECTS_MIGRATIONS: MigrationSource = {
  module: "projects",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

/** What the sessions module asks of projects: one per session folder's scope, their views, and their changes. */
export interface ProjectsPort {
  ensure(ownerId: string, root: string): ProjectView | null;
  list(ownerId: string, ids: readonly string[]): ProjectView[];
  onChange(listener: (ownerId: string, project: ProjectView) => void): () => void;
}

export interface ProjectsModule {
  readonly rpc: ProjectsRpc;
  readonly port: ProjectsPort;
}

export function createProjectsModule(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  newId(): string;
}): ProjectsModule {
  const service = createProjectsService({
    store: createProjectsStore(deps.db),
    clock: deps.clock,
    logger: deps.logger.child({ module: "projects" }),
    newId: deps.newId,
  });
  return {
    rpc: projectsRpc(service),
    port: { ensure: service.ensure, list: service.list, onChange: service.onChange },
  };
}
