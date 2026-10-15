import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { projectsRpc, type ProjectsRpc } from "./rpc.ts";
import { createProjectsService, type ProjectFolders, type ProjectView } from "./service.ts";
import { createProjectsStore } from "./store.ts";

export type { ProjectFolders, ProjectView } from "./service.ts";

export const PROJECTS_MIGRATIONS: MigrationSource = {
  module: "projects",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

/** What the sessions module asks of projects: one per session folder's scope, their views, and their changes. */
export interface ProjectsPort {
  ensure(ownerId: string, root: string): ProjectView | null;
  list(ownerId: string, ids: readonly string[]): ProjectView[];
  /** Every project of the owner, in the person's order: the snapshot lists the ones no session files under (decision 85). */
  all(ownerId: string): ProjectView[];
  /** Every project root of the owner as stored, newest first (M8R15, M8R19). */
  roots(ownerId: string): readonly string[];
  /** True when `path` is a root of the owner's projects or inside one: the folders a caller may ask about (M7R50). */
  covers(ownerId: string, path: string): boolean;
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
  /** `projects.add`'s folder rules (the daemon passes them; test beds that never add may leave them out). */
  readonly folders?: ProjectFolders;
  newId(): string;
}): ProjectsModule {
  const service = createProjectsService({
    store: createProjectsStore(deps.db),
    clock: deps.clock,
    logger: deps.logger.child({ module: "projects" }),
    newId: deps.newId,
    ...(deps.folders ? { folders: deps.folders } : {}),
  });
  return {
    rpc: projectsRpc(service),
    port: {
      ensure: service.ensure,
      list: service.list,
      all: service.all,
      roots: service.roots,
      covers: service.covers,
      onChange: service.onChange,
    },
  };
}
