import type {
  AgentResources,
  AUDIT_ACTORS,
  BoxOpArgs,
  BoxOpName,
  BoxOpValue,
  BoxPhase,
} from "@pap/contracts";

/** Who an audited change is for: no module exports one yet, so this follows the audit row's `actor` and `actorId`. */
export interface BoxAuditActor {
  readonly actor: Exclude<(typeof AUDIT_ACTORS)[number], "worker">;
  readonly actorId: string | null;
}

/** The guest ops of a project box (spec boxes): a box that is not running answers `box_stopped` and is never started by a call. */
export interface BoxOps {
  call<N extends BoxOpName>(
    projectId: string,
    op: BoxOpArgs<N>,
    signal?: AbortSignal,
  ): Promise<BoxOpValue<N>>;
  /**
   * `call` for what must never keep a box alive (the vcs poll, Files subscriptions): it never resets the idle wait and never
   * starts anything.
   */
  poll<N extends BoxOpName>(
    projectId: string,
    op: BoxOpArgs<N>,
    signal?: AbortSignal,
  ): Promise<BoxOpValue<N>>;
}

export interface BoxControl {
  phase(projectId: string): BoxPhase;
  start(projectId: string): Promise<void>;
  restart(projectId: string): Promise<void>;
  dispose(projectId: string, stamp: number): Promise<void>;
  purge(projectId: string): Promise<void>;
  rebuild(projectId: string): Promise<void>;
  packages(projectId: string): {
    readonly built: readonly string[];
    readonly wanted: readonly string[] | null;
  };
  onPhase(listener: (projectId: string, phase: BoxPhase) => void): () => void;
  /** The project folder of the box (`/boxes/<id>/project` on Kata): what `projects.root` stores and a session gets as its cwd. */
  rootOf(projectId: string): string;
}

export interface ProjectBoxRow {
  readonly ownerId: string;
  readonly root: string;
  readonly resources: AgentResources;
  readonly hosts: readonly string[];
  readonly deleting: boolean;
}

export interface ProjectBoxSource {
  box(projectId: string): ProjectBoxRow | null;
  byPath(ownerId: string, path: string): { readonly projectId: string; readonly root: string } | null;
  addHost(projectId: string, host: string, actor: BoxAuditActor): void;
}
