import type { RepoFullName } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

export type KeyState = "absent" | "added" | "removing" | "failed";
export type CloneState = "pending" | "done" | "failed";
/** The fixed words a failed clone is shown with. */
export type CloneError = "auth" | "network" | "not_found" | "failed";

export interface GithubProjectRow {
  readonly projectId: string;
  readonly ownerId: string;
  readonly repository: RepoFullName;
  readonly upstream: RepoFullName | null;
  readonly fork: boolean;
  /** False once unlinked or deleted: the row stays only while the signing key could not be removed from GitHub. */
  readonly linked: boolean;
  readonly keyId: number | null;
  readonly keyState: KeyState;
  readonly cloneState: CloneState | null;
  readonly cloneError: CloneError | null;
}

interface Raw {
  projectId: string;
  ownerId: string;
  repository: string;
  upstream: string | null;
  fork: number;
  linked: number;
  keyId: number | null;
  keyState: KeyState;
  cloneState: CloneState | null;
  cloneError: CloneError | null;
}

export interface GithubProjectStore {
  get(projectId: string): GithubProjectRow | undefined;
  /** Rows whose key removal failed, or was cut short by a restart: the sweep retries them. */
  withPendingRemoval(): GithubProjectRow[];
  /** A new row, or a relinked one (an unlinked row whose key is gone): the key and clone fields start over. */
  put(
    row: Pick<GithubProjectRow, "projectId" | "ownerId" | "repository" | "upstream" | "fork" | "cloneState">,
  ): void;
  setClone(projectId: string, state: CloneState, error: CloneError | null): void;
  setKey(projectId: string, keyId: number | null, state: KeyState): void;
  setLinked(projectId: string, linked: boolean): void;
  remove(projectId: string): void;
}

const SELECT = `SELECT project_id AS projectId, owner_id AS ownerId, repository, upstream, fork, linked,
  key_id AS keyId, key_state AS keyState, clone_state AS cloneState, clone_error AS cloneError FROM project_github`;

const rowOf = (raw: Raw): GithubProjectRow => ({
  projectId: raw.projectId,
  ownerId: raw.ownerId,
  repository: raw.repository as RepoFullName,
  upstream: raw.upstream as RepoFullName | null,
  fork: raw.fork === 1,
  linked: raw.linked === 1,
  keyId: raw.keyId,
  keyState: raw.keyState,
  cloneState: raw.cloneState,
  cloneError: raw.cloneError,
});

export function createGithubProjectStore(db: Db): GithubProjectStore {
  return {
    get: (projectId) => {
      const raw = db.get<Raw>(`${SELECT} WHERE project_id = $projectId`, { projectId });
      return raw && rowOf(raw);
    },
    withPendingRemoval: () => db.all<Raw>(`${SELECT} WHERE key_state IN ('failed', 'removing')`).map(rowOf),
    put: (row) => {
      db.run(
        `INSERT OR REPLACE INTO project_github (project_id, owner_id, repository, upstream, fork, linked, key_id, key_state, clone_state, clone_error)
         VALUES ($projectId, $ownerId, $repository, $upstream, $fork, 1, NULL, 'absent', $cloneState, NULL)`,
        { ...row, fork: row.fork ? 1 : 0 },
      );
    },
    setClone: (projectId, state, error) => {
      db.run(
        "UPDATE project_github SET clone_state = $state, clone_error = $error WHERE project_id = $projectId",
        {
          projectId,
          state,
          error,
        },
      );
    },
    setKey: (projectId, keyId, state) => {
      db.run("UPDATE project_github SET key_id = $keyId, key_state = $state WHERE project_id = $projectId", {
        projectId,
        keyId,
        state,
      });
    },
    setLinked: (projectId, linked) => {
      db.run("UPDATE project_github SET linked = $linked WHERE project_id = $projectId", {
        projectId,
        linked: linked ? 1 : 0,
      });
    },
    remove: (projectId) => {
      db.run("DELETE FROM project_github WHERE project_id = $projectId", { projectId });
    },
  };
}
