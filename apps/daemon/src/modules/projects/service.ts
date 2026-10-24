import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import {
  type BoxOpArgs,
  type BoxPhase,
  type Caller,
  PapError,
  type ProjectChange,
  SHELL_LIMITS,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import { within } from "../../kernel/fs/boundary.ts";
import { enableKnowledge, knowledgeOf } from "../../kernel/fs/knowledge.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { cleanLabel } from "../../kernel/text.ts";
import type { AuditPort } from "../audit/index.ts";
import { type BoxStore } from "./box-store.ts";
import { createBoxService } from "./box-service.ts";
import { isCleanPath, MAX_PROJECTS } from "./limits.ts";
import type { ProjectRow, ProjectsStore } from "./store.ts";

export type { ProjectBoxWiring } from "./box-service.ts";

export { MAX_PROJECTS } from "./limits.ts";
const MAX_ROOT = 4096;
/** Two neighbours closer than this are renumbered 1..n (M4R21). */
const MIN_GAP = 1e-6;

export interface ProjectView {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly position: number;
  /** A box project (its files live in a microVM); absent for a host project. */
  readonly kind?: "box";
  /** The owner's one Scratch project. */
  readonly scratch?: true;
  /** A box project's microVM phase; the shell stream carries it to the web. */
  readonly box?: { readonly phase: BoxPhase };
}

/**
 * How `projects.add` reads a folder (decision 85), given by the composition: the rules `sessions.create` follows, so
 * adding a folder makes exactly the project a session in it would make (PH1).
 */
export interface ProjectFolders {
  /** The real path of an existing folder; `invalid_cwd` for anything else (sessions' `resolveSessionCwd`). */
  resolve(input: string): string;
  /** The project a real folder files under: its git root, else itself (`policy.scopeOf`, M2R68). */
  scopeOf(real: string): string;
  /** pap's home (lane worktrees, secrets, the database) and Pi's agent folder: no project lives inside them. */
  readonly stateDirs: readonly string[];
}

/** Where a project's OKF bundle lives for a session (a lane's worktree, else the project's folder), given by the composition. */
export interface ProjectKnowledge {
  /** The root a session sees, given the project folder its folder files under (`scope`): its lane's worktree, else `scope`; null outside every project. */
  rootOfRow(row: { ownerId: string; cwd: string }, scope: string): string | null;
  /** The root of the owner's project as `sessionId` sees it (a lane session: its worktree); null for an unknown project. */
  rootFor(ownerId: string, projectId: string, sessionId?: string): string | null;
  /** The audit row of an enable. */
  enabled(caller: Caller, projectId: string): void;
}

// C0 controls, NUL included: a root is a real path, and a path with a control character is not one pap makes a project of.
const hasControl = (text: string): boolean => [...text].some((char) => (char.codePointAt(0) ?? 0x20) < 0x20);
const defaultName = (root: string): string =>
  cleanLabel(basename(root), SHELL_LIMITS.projectName) ?? cleanLabel(root, SHELL_LIMITS.projectName) ?? "/";
/** A state folder as it really is (a link resolved), or its absolute form when it does not exist yet. */
const realOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function createProjectsService(deps: {
  readonly store: ProjectsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Absent: `add` refuses with `internal` (fail closed). The daemon always gives it. */
  readonly folders?: ProjectFolders;
  readonly knowledge?: ProjectKnowledge;
  readonly boxes: BoxStore;
  readonly audit?: Pick<AuditPort, "append">;
  newId(): string;
}) {
  const listeners = new Set<(ownerId: string, project: ProjectView) => void>();
  const limiter = createRateLimiter(deps.clock, 60_000);
  // A listener that fails (the shell publisher, say) must not stop the others nor fail the change that called it.
  const changed = (ownerId: string, project: ProjectView) => {
    for (const listener of [...listeners]) {
      try {
        listener(ownerId, project);
      } catch (error) {
        deps.logger.warn("projects_listener_failed", { err: error });
      }
    }
  };
  const removedListeners = new Set<(ownerId: string, projectId: string) => void>();
  const removed = (ownerId: string, projectId: string) => {
    for (const listener of [...removedListeners]) {
      try {
        listener(ownerId, projectId);
      } catch (error) {
        deps.logger.warn("projects_listener_failed", { err: error });
      }
    }
  };
  const owned = (ownerId: string, id: string): ProjectRow => {
    const row = deps.store.get(ownerId, id);
    if (!row) throw new PapError("not_found");
    return row;
  };
  const boxes = createBoxService({
    store: deps.store,
    boxes: deps.boxes,
    clock: deps.clock,
    logger: deps.logger,
    newId: deps.newId,
    changed,
    removed,
    owned,
    ...(deps.audit ? { audit: deps.audit } : {}),
  });
  const { viewOf } = boxes;

  /** The fractional position that puts a project before `before` (last when null or unknown), or null when too tight. */
  function placeBefore(ownerId: string, id: string, before: string | null): number | null {
    const order = deps.store.list(ownerId).filter((row) => row.id !== id);
    const at = before === null ? -1 : order.findIndex((row) => row.id === before);
    if (at === -1) return (order.at(-1)?.position ?? 0) + 1;
    const next = order[at] as ProjectRow;
    const previous = order[at - 1];
    if (!previous) return next.position - 1;
    const position = (previous.position + next.position) / 2;
    return next.position - previous.position < MIN_GAP ? null : position;
  }

  function applyUpdate(caller: Caller, projectId: string, change: ProjectChange): void {
    const row = owned(caller.userId, projectId);
    if (change.kind === "rename") {
      const name = cleanLabel(change.name, SHELL_LIMITS.projectName);
      if (name === null) throw new PapError("bad_request");
      deps.store.rename(caller.userId, row.id, name);
      changed(caller.userId, viewOf(owned(caller.userId, row.id)));
      return;
    }
    const position = placeBefore(caller.userId, row.id, change.before);
    if (position !== null) {
      deps.store.setPosition(caller.userId, row.id, position);
      changed(caller.userId, viewOf(owned(caller.userId, row.id)));
      return;
    }
    // Too tight to split: renumber the order with the project in its new place, and publish every position.
    const order = deps.store
      .list(caller.userId)
      .map((project) => project.id)
      .filter((id) => id !== row.id);
    const at = change.before === null ? -1 : order.indexOf(change.before);
    order.splice(at === -1 ? order.length : at, 0, row.id);
    deps.store.renumber(caller.userId, order);
    for (const project of deps.store.list(caller.userId)) changed(caller.userId, viewOf(project));
  }

  /** The owner's project for `root`, made on first use at the top; null for a root it cannot use or a full table. */
  function ensure(ownerId: string, root: string): ProjectView | null {
    if (!isAbsolute(root) || root.length > MAX_ROOT || hasControl(root)) return null;
    const found = deps.store.byRoot(ownerId, root);
    if (found) return viewOf(found);
    if (deps.store.count(ownerId) >= MAX_PROJECTS) {
      const said = limiter.check("projects_full");
      if (said.allowed) deps.logger.warn("projects_full", { max: MAX_PROJECTS, suppressed: said.suppressed });
      return null;
    }
    const row: ProjectRow = {
      id: deps.newId(),
      ownerId,
      root,
      name: defaultName(root),
      position: (deps.store.firstPosition(ownerId) ?? 0) - 1,
      createdAt: deps.clock.now(),
      kind: "host",
    };
    deps.store.insert(row);
    const view = viewOf(row);
    changed(ownerId, view);
    return view;
  }

  /**
   * `projects.add` (decision 85): the folder's project, made when it is new, the same one when it exists. The real path
   * and its scope are both refused inside pap's home or Pi's agent folder, whatever link led there (Review Focus 4).
   */
  function add(caller: Caller, root: string): ProjectView {
    const folders = deps.folders;
    if (folders === undefined) throw new PapError("internal");
    const real = folders.resolve(root);
    const scope = folders.scopeOf(real);
    const states = folders.stateDirs.map(realOrResolved);
    if ([real, scope].some((path) => states.some((state) => within(state, path))))
      throw new PapError("bad_request");
    if (!isAbsolute(scope) || scope.length > MAX_ROOT || hasControl(scope)) throw new PapError("bad_request");
    try {
      const view = ensure(caller.userId, scope);
      if (view === null) throw new PapError("capacity");
      return view;
    } catch (error) {
      // A database a newer pap wrote refuses the write: a typed error, not SQLite's message.
      throw isReadOnlyError(error) ? new PapError("read_only") : error;
    }
  }

  function knowledgeRoot(caller: Caller, projectId: string, sessionId: string | undefined): string {
    owned(caller.userId, projectId);
    if (deps.knowledge === undefined) throw new PapError("internal");
    const root = deps.knowledge.rootFor(caller.userId, projectId, sessionId);
    if (root === null) throw new PapError("not_found");
    return root;
  }

  /** A box project's knowledge is the guest's: a stopped box answers `box_stopped` and is never started. */
  async function viaGuest<N extends "knowledge.state" | "knowledge.enable">(projectId: string, name: N) {
    const wiring = boxes.wiring();
    if (wiring === undefined) throw new PapError("internal");
    if (deps.boxes.get(projectId)?.deleting) throw new PapError("not_found");
    if (wiring.control.phase(projectId) !== "running") throw new PapError("box_stopped");
    return await wiring.ops.call(projectId, { name } as BoxOpArgs<N>);
  }
  const rootsCovering = (ownerId: string, path: string) =>
    isCleanPath(path)
      ? deps.store
          .list(ownerId)
          .filter(
            (row) => path === row.root || path.startsWith(row.root.endsWith("/") ? row.root : `${row.root}/`),
          )
      : [];
  const isBox = (ownerId: string, projectId: string): boolean => owned(ownerId, projectId).kind === "box";

  return {
    ensure,
    add,
    bindBoxes: boxes.bind,
    create: boxes.create,
    scratch: boxes.scratch,
    box: boxes.box,
    setBox: boxes.setBox,
    startBox: boxes.start,
    restartBox: boxes.restart,
    rebuild: boxes.rebuild,
    remove: boxes.remove,
    async knowledge(caller: Caller, projectId: string, sessionId?: string) {
      if (isBox(caller.userId, projectId)) return await viaGuest(projectId, "knowledge.state");
      return knowledgeOf(knowledgeRoot(caller, projectId, sessionId));
    },
    /** Makes the bundle (`conflict` when `knowledge` is a link or a file: nothing written) and audits it. */
    async enableKnowledge(caller: Caller, projectId: string, sessionId?: string): Promise<{ enabled: true }> {
      if (isBox(caller.userId, projectId)) {
        await viaGuest(projectId, "knowledge.enable");
        deps.knowledge?.enabled(caller, projectId);
        return { enabled: true };
      }
      enableKnowledge(knowledgeRoot(caller, projectId, sessionId), new Date(deps.clock.now()));
      deps.knowledge?.enabled(caller, projectId);
      return { enabled: true };
    },
    /** True when `path` is one of the owner's project roots or lies inside one (what a session's folder is filed under). */
    covers(ownerId: string, path: string): boolean {
      return rootsCovering(ownerId, path).length > 0;
    },
    /**
     * Like `covers`, for the host's own readers (Pi's helpers, which open the folder): false for a box project's root or
     * anything inside it, whatever a host project root around it says. A box's files are the VM's, never the host's.
     */
    coversHost(ownerId: string, path: string): boolean {
      const covering = rootsCovering(ownerId, path);
      return covering.length > 0 && covering.every((row) => row.kind !== "box");
    },
    list: (ownerId: string, ids: readonly string[]): ProjectView[] =>
      deps.store.byIds(ownerId, ids).map(viewOf),
    /** Every project of the owner, in the person's order (the shell snapshot's unused ones, decision 85). */
    all: (ownerId: string): ProjectView[] => deps.store.list(ownerId).map(viewOf),
    /** Every root of the owner, as stored, newest first: what the file boundary judges paths against (M8R15). */
    roots: (ownerId: string): string[] => deps.store.roots(ownerId),
    update(caller: Caller, projectId: string, change: ProjectChange): void {
      try {
        applyUpdate(caller, projectId, change);
      } catch (error) {
        // A database a newer pap wrote refuses the write: a typed error, not SQLite's message.
        throw isReadOnlyError(error) ? new PapError("read_only") : error;
      }
    },
    onChange(listener: (ownerId: string, project: ProjectView) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Called after a box project and its rows are gone (its sessions with it): the shell stream drops it everywhere. */
    onRemoved(listener: (ownerId: string, projectId: string) => void): () => void {
      removedListeners.add(listener);
      return () => void removedListeners.delete(listener);
    },
  };
}
export type ProjectsService = ReturnType<typeof createProjectsService>;
