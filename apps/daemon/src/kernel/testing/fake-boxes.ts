import {
  PapError,
  type BoxOpArgs,
  type BoxOpName,
  type BoxOpValue,
  type BoxPhase,
  type PreviewDecl,
} from "@pap/contracts";
import type { BoxAuditActor, BoxControl, BoxOps, ProjectBoxRow, ProjectBoxSource } from "../boxes.ts";

type Handlers = {
  readonly [N in BoxOpName]?: (op: BoxOpArgs<N>, projectId: string) => BoxOpValue<N> | Promise<BoxOpValue<N>>;
};

export interface FakeBoxOps extends BoxOps {
  readonly calls: Array<{
    readonly projectId: string;
    readonly op: BoxOpArgs;
    readonly signal: AbortSignal | undefined;
  }>;
  /** The `poll`s, recorded like `calls` (they answer the same handlers). */
  readonly polls: FakeBoxOps["calls"];
  /** Every `call` and `poll` in the order they came. */
  readonly all: FakeBoxOps["calls"];
}

/** Answers each op with its handler; an op without a handler fails like a guest that does not know it (`bad_request`). */
export function createFakeBoxOps(handlers: Handlers = {}): FakeBoxOps {
  const calls: FakeBoxOps["calls"] = [];
  const polls: FakeBoxOps["calls"] = [];
  const all: FakeBoxOps["calls"] = [];
  const answer = async <N extends BoxOpName>(
    log: FakeBoxOps["calls"],
    projectId: string,
    op: BoxOpArgs<N>,
    signal?: AbortSignal,
  ): Promise<BoxOpValue<N>> => {
    {
      log.push({ projectId, op, signal });
      all.push({ projectId, op, signal });
      const handler = handlers[op.name] as
        ((op: BoxOpArgs<N>, projectId: string) => BoxOpValue<N> | Promise<BoxOpValue<N>>) | undefined;
      if (!handler) throw new PapError("bad_request");
      return await handler(op, projectId);
    }
  };
  return {
    calls,
    polls,
    all,
    call: (projectId, op, signal) => answer(calls, projectId, op, signal),
    poll: (projectId, op, signal) => answer(polls, projectId, op, signal),
  };
}

export type FakeBoxCall = readonly [method: string, projectId: string, ...rest: unknown[]];

export interface FakeBoxControl extends BoxControl {
  readonly calls: FakeBoxCall[];
  /** Sets a phase and tells the listeners, like the real control does when a box moves. */
  setPhase(projectId: string, phase: BoxPhase): void;
  setPackages(
    projectId: string,
    packages: { built: readonly string[]; wanted: readonly string[] | null },
  ): void;
  setPreview(projectId: string, preview: { decl: PreviewDecl | null; invalid: boolean }): void;
}

/** Every box is `stopped` unless `initial` says otherwise; `start` and `restart` leave it `running`, `dispose` and `purge` stopped. */
export function createFakeBoxControl(initial: Readonly<Record<string, BoxPhase>> = {}): FakeBoxControl {
  const phases = new Map(Object.entries(initial));
  const packages = new Map<string, { built: readonly string[]; wanted: readonly string[] | null }>();
  const previews = new Map<string, { decl: PreviewDecl | null; invalid: boolean }>();
  const listeners = new Set<(projectId: string, phase: BoxPhase) => void>();
  const calls: FakeBoxCall[] = [];
  const setPhase = (projectId: string, phase: BoxPhase): void => {
    if (phases.get(projectId) === phase) return;
    phases.set(projectId, phase);
    for (const listener of [...listeners]) listener(projectId, phase);
  };
  return {
    calls,
    setPhase,
    setPackages: (projectId, value) => void packages.set(projectId, value),
    setPreview: (projectId, value) => void previews.set(projectId, value),
    notePreview: (projectId, decl, invalid) => void previews.set(projectId, { decl, invalid }),
    preview: (projectId) => previews.get(projectId) ?? { decl: null, invalid: false },
    phase: (projectId) => phases.get(projectId) ?? "stopped",
    async start(projectId) {
      calls.push(["start", projectId]);
      setPhase(projectId, "running");
    },
    async restart(projectId) {
      calls.push(["restart", projectId]);
      setPhase(projectId, "running");
    },
    async stop(projectId) {
      calls.push(["stop", projectId]);
      setPhase(projectId, "stopped");
    },
    async dispose(projectId, stamp) {
      calls.push(["dispose", projectId, stamp]);
      setPhase(projectId, "stopped");
    },
    async purge(projectId) {
      calls.push(["purge", projectId]);
      setPhase(projectId, "stopped");
    },
    async rebuild(projectId) {
      calls.push(["rebuild", projectId]);
    },
    packages: (projectId) => packages.get(projectId) ?? { built: [], wanted: null },
    onPhase(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    rootOf: (projectId) => `/boxes/${projectId}/project`,
  };
}

export interface FakeProjectBoxSource extends ProjectBoxSource {
  readonly added: Array<{ readonly projectId: string; readonly host: string; readonly actor: BoxAuditActor }>;
}

/** `rows` by project id; `byPath` matches a path equal to a row's `root` (its project folder) or below it, whole segments only, no `.`, `..` or empty segment. */
export function createFakeProjectBoxSource(
  rows: Readonly<Record<string, ProjectBoxRow>>,
): FakeProjectBoxSource {
  const added: FakeProjectBoxSource["added"] = [];
  const clean = (path: string): boolean =>
    path.startsWith("/") &&
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..");
  return {
    added,
    box: (projectId) => rows[projectId] ?? null,
    ownerBoxes: (ownerId) =>
      Object.entries(rows)
        .filter(([, row]) => row.ownerId === ownerId)
        .map(([projectId]) => projectId),
    byPath(ownerId, path) {
      if (!clean(path)) return null;
      for (const [projectId, row] of Object.entries(rows)) {
        if (row.ownerId === ownerId && (path === row.root || path.startsWith(`${row.root}/`))) {
          return { projectId, root: row.root };
        }
      }
      return null;
    },
    addHost(projectId, host, actor) {
      added.push({ projectId, host, actor });
    },
  };
}
