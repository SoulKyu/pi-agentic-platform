import { basename, isAbsolute } from "node:path";
import { type Caller, PapError, type ProjectChange, SHELL_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { cleanLabel } from "../../kernel/text.ts";
import type { ProjectRow, ProjectsStore } from "./store.ts";

/** Projects per owner (M4R22). */
export const MAX_PROJECTS = 2000;
const MAX_ROOT = 4096;
/** Two neighbours closer than this are renumbered 1..n (M4R21). */
const MIN_GAP = 1e-6;

export interface ProjectView {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly position: number;
}

const viewOf = (row: ProjectRow): ProjectView => ({
  id: row.id,
  root: row.root,
  name: row.name,
  position: row.position,
});
// C0 controls, NUL included: a root is a real path, and a path with a control character is not one pap makes a project of.
const hasControl = (text: string): boolean => [...text].some((char) => (char.codePointAt(0) ?? 0x20) < 0x20);
// A path to compare lexically: absolute, no NUL, no empty, `.` or `..` segment, no trailing slash.
const isCleanPath = (path: string): boolean =>
  path.startsWith("/") &&
  !path.includes("\0") &&
  (path === "/" ||
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."));
const defaultName = (root: string): string =>
  cleanLabel(basename(root), SHELL_LIMITS.projectName) ?? cleanLabel(root, SHELL_LIMITS.projectName) ?? "/";

export function createProjectsService(deps: {
  readonly store: ProjectsStore;
  readonly clock: Clock;
  readonly logger: Logger;
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
  const owned = (ownerId: string, id: string): ProjectRow => {
    const row = deps.store.get(ownerId, id);
    if (!row) throw new PapError("not_found");
    return row;
  };

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

  return {
    /** The owner's project for `root`, made on first use at the top; null for a root it cannot use or a full table. */
    ensure(ownerId: string, root: string): ProjectView | null {
      if (!isAbsolute(root) || root.length > MAX_ROOT || hasControl(root)) return null;
      const found = deps.store.byRoot(ownerId, root);
      if (found) return viewOf(found);
      if (deps.store.count(ownerId) >= MAX_PROJECTS) {
        const said = limiter.check("projects_full");
        if (said.allowed)
          deps.logger.warn("projects_full", { max: MAX_PROJECTS, suppressed: said.suppressed });
        return null;
      }
      const row: ProjectRow = {
        id: deps.newId(),
        ownerId,
        root,
        name: defaultName(root),
        position: (deps.store.firstPosition(ownerId) ?? 0) - 1,
        createdAt: deps.clock.now(),
      };
      deps.store.insert(row);
      const view = viewOf(row);
      changed(ownerId, view);
      return view;
    },
    /** True when `path` is one of the owner's project roots or lies inside one (what a session's folder is filed under). */
    covers(ownerId: string, path: string): boolean {
      if (!isCleanPath(path)) return false;
      return deps.store
        .list(ownerId)
        .some(
          (row) => path === row.root || path.startsWith(row.root.endsWith("/") ? row.root : `${row.root}/`),
        );
    },
    list: (ownerId: string, ids: readonly string[]): ProjectView[] =>
      deps.store.byIds(ownerId, ids).map(viewOf),
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
  };
}
export type ProjectsService = ReturnType<typeof createProjectsService>;
