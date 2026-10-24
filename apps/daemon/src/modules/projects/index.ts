import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { createProjectBoxSource } from "./box-source.ts";
import { createBoxStore } from "./box-store.ts";
import { projectsRpc, type ProjectsRpc } from "./rpc.ts";
import {
  createProjectsService,
  type ProjectBoxWiring,
  type ProjectFolders,
  type ProjectKnowledge,
  type ProjectView,
} from "./service.ts";
import { createProjectsStore } from "./store.ts";

export type { ProjectBoxWiring, ProjectFolders, ProjectKnowledge, ProjectView } from "./service.ts";

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
  /** `covers` for the host's readers (Pi's helpers): false for a box project's root and everything under it. */
  coversHost(ownerId: string, path: string): boolean;
  /** The folder whose `knowledge/` a session sees: its lane's worktree, else `scope`, the project folder of its own folder. */
  knowledgeRootOf?(row: { ownerId: string; cwd: string }, scope: string): string | null;
  onChange(listener: (ownerId: string, project: ProjectView) => void): () => void;
  /** A box project was deleted: its row and its sessions are gone. */
  onRemoved(listener: (ownerId: string, projectId: string) => void): () => void;
}

export interface ProjectsModule {
  readonly rpc: ProjectsRpc;
  readonly port: ProjectsPort;
  /** What the files, vcs and sessions modules ask of the owner's box projects (boxes B1). */
  readonly boxSource: ProjectBoxSource;
  /** The composition gives the real box control and the cleanups once they exist (late); until then the box methods answer `internal`. */
  bindBoxes(wiring: ProjectBoxWiring): void;
}

export function createProjectsModule(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `projects.add`'s folder rules (the daemon passes them; test beds that never add may leave them out). */
  readonly folders?: ProjectFolders;
  /** Where a project's OKF bundle is and who is told when one is made; absent: the knowledge methods answer `internal`. */
  readonly knowledge?: ProjectKnowledge;
  /** The audit rows of a box project's creation, change, delete and added hosts. */
  readonly audit?: Pick<AuditPort, "append">;
  newId(): string;
}): ProjectsModule {
  const boxes = createBoxStore(deps.db);
  const service = createProjectsService({
    store: createProjectsStore(deps.db),
    boxes,
    ...(deps.audit ? { audit: deps.audit } : {}),
    clock: deps.clock,
    logger: deps.logger.child({ module: "projects" }),
    newId: deps.newId,
    ...(deps.folders ? { folders: deps.folders } : {}),
    ...(deps.knowledge ? { knowledge: deps.knowledge } : {}),
  });
  return {
    rpc: projectsRpc(service),
    boxSource: createProjectBoxSource(boxes, deps.audit),
    bindBoxes: service.bindBoxes,
    port: {
      ensure: service.ensure,
      list: service.list,
      all: service.all,
      roots: service.roots,
      covers: service.covers,
      coversHost: service.coversHost,
      ...(deps.knowledge ? { knowledgeRootOf: deps.knowledge.rootOfRow } : {}),
      onChange: service.onChange,
      onRemoved: service.onRemoved,
    },
  };
}
