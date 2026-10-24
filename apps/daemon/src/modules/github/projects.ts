import {
  type Caller,
  PapError,
  type ParamsOf,
  type ProjectGithubView,
  RepoFullName,
  type ResultOf,
} from "@pap/contracts";
import { z } from "zod";
import type { BoxControl, BoxOps, BoxAuditActor, ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { ProjectsModule } from "../projects/index.ts";
import { assertBrowserCaller } from "./browser-only.ts";
import type { Delivery } from "./deliver.ts";
import type { GithubCore } from "./index.ts";
import type { ProjectKeys } from "./keys.ts";
import type { GithubProjectRow, GithubProjectStore } from "./project-store.ts";
import { appReaches, listRepositories, requireInstallation } from "./repositories.ts";

/** What a clone, a push, `gh` and the release assets reach (spec boxes B2 §4); the owner may edit the list. */
export const GITHUB_HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
] as const;
export const FORK_POLL_MS = 2_000;
/** 60 s at one poll every 2 s. */
export const FORK_POLLS = 30;

const Forked = z.object({ full_name: z.string() });

/** What the composition gives once the real box control exists. */
export interface GithubBoxes {
  readonly control: BoxControl;
  readonly ops: BoxOps;
  readonly delivery: Delivery;
}

export interface GithubProjectsService {
  repositories(caller: Caller, query: string | undefined): Promise<ResultOf<"github.repositories">>;
  createFromGithub(
    caller: Caller,
    params: ParamsOf<"projects.createFromGithub">,
  ): Promise<ResultOf<"projects.createFromGithub">>;
  linkGithub(caller: Caller, params: ParamsOf<"projects.linkGithub">): Promise<ProjectGithubView>;
  unlinkGithub(caller: Caller, projectId: string): Promise<void>;
  cloneAgain(caller: Caller, projectId: string): Promise<void>;
  /** The project's GitHub state; the lists stay empty until B4 reads them. */
  view(row: GithubProjectRow): ProjectGithubView;
  /** The project and its rows are gone: its signing key goes too. */
  removed(ownerId: string, projectId: string): void;
}

export function createGithubProjects(deps: {
  readonly core: GithubCore;
  readonly store: GithubProjectStore;
  readonly keys: ProjectKeys;
  readonly projects: Pick<ProjectsModule, "create" | "hasRoom" | "boxSource" | "port">;
  readonly audit: Pick<AuditPort, "append">;
  readonly clock: Clock;
  readonly logger: Logger;
  boxes(): GithubBoxes;
  /** The project was linked or unlinked: its cached lists go. */
  changed(projectId: string): void;
}): GithubProjectsService {
  const { core, store, keys, clock, logger } = deps;
  const source: ProjectBoxSource = deps.projects.boxSource;

  const actorOf = (caller: Caller): BoxAuditActor => ({
    actor: caller.kind === "token" ? "token" : "user",
    actorId: caller.kind === "token" ? (caller.credentialId ?? null) : null,
  });
  const record = (caller: Caller, reason: string, projectId: string): void =>
    deps.audit.append({
      ownerId: caller.userId,
      actor: caller.kind === "token" ? "token" : "user",
      kind: "policy",
      reason,
      detail: { projectId },
    });
  /** A live box project of the caller's. */
  function boxOf(caller: Caller, projectId: string): { root: string } {
    const box = source.box(projectId);
    if (!box || box.ownerId !== caller.userId || box.deleting) throw new PapError("not_found");
    return box;
  }
  const guard = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      throw isReadOnlyError(error) ? new PapError("read_only") : error;
    }
  };
  const seedHosts = (caller: Caller, projectId: string): void => {
    for (const host of GITHUB_HOSTS) source.addHost(projectId, host, actorOf(caller));
  };
  const requireApp = (): void => {
    if (core.appSecrets.load() === null) throw new PapError("github_unavailable");
  };

  /** Forks into the owner's account with the user token, then waits (2 s polls, 60 s at most) until the fork answers. */
  async function fork(ownerId: string, repository: RepoFullName): Promise<RepoFullName> {
    const auth = { kind: "bearer", value: await core.userTokens.get(ownerId) } as const;
    const made = await core.client.json(Forked, { method: "POST", path: `/repos/${repository}/forks`, auth });
    const name = RepoFullName.safeParse(made.full_name);
    if (!name.success) throw new PapError("github_unavailable");
    for (let poll = 0; poll <= FORK_POLLS; poll += 1) {
      try {
        await core.client.json(Forked, { path: `/repos/${name.data}`, auth });
        return name.data;
      } catch (error) {
        if (!(error instanceof PapError && error.code === "not_found")) throw error;
      }
      if (poll < FORK_POLLS) await clock.sleep(FORK_POLL_MS);
    }
    logger.warn("github_fork_timeout");
    throw new PapError("github_unavailable");
  }

  function view(row: GithubProjectRow): ProjectGithubView {
    return {
      link: row.linked ? { repository: row.repository, upstream: row.upstream, fork: row.fork } : null,
      key: row.keyState,
      clone: row.cloneState === null ? null : { state: row.cloneState, error: row.cloneError },
      pulls: [],
      issues: [],
      releases: [],
      fetchedAt: null,
    };
  }

  return {
    view,
    async repositories(caller, query) {
      assertBrowserCaller("github.repositories", caller);
      requireApp();
      return { repositories: await listRepositories(core, caller.userId, query) };
    },
    async createFromGithub(caller, { repository, mode, name }) {
      assertBrowserCaller("projects.createFromGithub", caller);
      deps.boxes();
      requireApp();
      // Every refusal that can be known comes before the fork: a refused call never leaves a fork behind.
      if (!deps.projects.hasRoom(caller.userId)) throw new PapError("capacity");
      // A fork's upstream is someone else's: only the fork counts, and the owner needs an installation to receive it.
      if (mode === "clone") await appReaches(core, repository);
      else await requireInstallation(core, caller.userId);
      const linked = mode === "fork" ? await fork(caller.userId, repository) : repository;
      if (mode === "fork") await appReaches(core, linked);
      const project = deps.projects.create(caller, name ?? repository.split("/")[1] ?? repository);
      guard(() =>
        store.put({
          projectId: project.id,
          ownerId: caller.userId,
          repository: linked,
          upstream: mode === "fork" ? repository : null,
          fork: mode === "fork",
          cloneState: "pending",
        }),
      );
      seedHosts(caller, project.id);
      record(caller, mode === "fork" ? "project_github_forked" : "project_github_cloned", project.id);
      return { project };
    },
    async linkGithub(caller, { projectId, repository }) {
      assertBrowserCaller("projects.linkGithub", caller);
      const { control, ops, delivery } = deps.boxes();
      boxOf(caller, projectId);
      requireApp();
      const existing = store.get(projectId);
      if (existing?.linked) throw new PapError("conflict");
      if (control.phase(projectId) !== "running") throw new PapError("box_stopped");
      await appReaches(core, repository);
      // An earlier unlink left its key behind: it goes first, so the new row never loses its id.
      if (existing && !(await keys.remove(existing))) throw new PapError("conflict");
      await ops.call(projectId, { name: "git.link", url: core.cloneUrl(repository) });
      guard(() =>
        store.put({
          projectId,
          ownerId: caller.userId,
          repository,
          upstream: null,
          fork: false,
          cloneState: null,
        }),
      );
      seedHosts(caller, projectId);
      deps.changed(projectId);
      record(caller, "project_github_linked", projectId);
      await delivery.begin(projectId);
      const row = store.get(projectId);
      if (!row) throw new PapError("internal");
      return view(row);
    },
    async unlinkGithub(caller, projectId) {
      assertBrowserCaller("projects.unlinkGithub", caller);
      const { control, ops, delivery } = deps.boxes();
      boxOf(caller, projectId);
      const row = store.get(projectId);
      if (!row?.linked) throw new PapError("not_found");
      if (control.phase(projectId) !== "running") throw new PapError("box_stopped");
      await ops.call(projectId, { name: "git.unlink" });
      await ops.call(projectId, { name: "github.forgetKey" });
      await delivery.forget(projectId);
      await delivery.exclusive(projectId, () => keys.release(row));
      deps.changed(projectId);
      record(caller, "project_github_unlinked", projectId);
    },
    async cloneAgain(caller, projectId) {
      assertBrowserCaller("projects.cloneAgain", caller);
      const { control, ops, delivery } = deps.boxes();
      const box = boxOf(caller, projectId);
      requireApp();
      const row = store.get(projectId);
      if (!row?.linked) throw new PapError("not_found");
      if (row.cloneState !== "failed") throw new PapError("conflict");
      if (control.phase(projectId) !== "running") throw new PapError("box_stopped");
      // Only an empty folder is cloned into: files there (a partial clone included) are never taken for a finished clone.
      const listing = await ops.call(projectId, { name: "fs.list", path: box.root, showIgnored: true });
      if (listing.entries.length > 0) throw new PapError("conflict");
      guard(() => store.setClone(projectId, "pending", null));
      void delivery.begin(projectId);
    },
    removed(ownerId, projectId) {
      const row = store.get(projectId);
      if (!row || row.ownerId !== ownerId) return;
      let delivery: Delivery | undefined;
      try {
        delivery = deps.boxes().delivery;
        void delivery.forget(projectId);
      } catch {
        // No box wiring: nothing was being delivered.
      }
      const release = (): Promise<void> => keys.release(row);
      void (delivery ? delivery.exclusive(projectId, release) : release()).catch((error: unknown) => {
        logger.warn("github_key_release_failed", { code: error instanceof PapError ? error.code : "error" });
      });
    },
  };
}
