import { type Caller, PapError, type ParamsOf, type ProjectGithubView, type ResultOf } from "@pap/contracts";
import { z } from "zod";
import type { BoxOps, ProjectBoxSource } from "../../kernel/boxes.ts";
import type { AuditPort } from "../audit/index.ts";
import { assertBrowserCaller } from "./browser-only.ts";
import type { GithubCore } from "./index.ts";
import type { Permissions } from "./tokens.ts";
import { createLists } from "./lists.ts";
import type { GithubProjectRow, GithubProjectStore } from "./project-store.ts";
import { createSend, type GithubSessionsPort } from "./send.ts";
import type { Clock } from "../../kernel/clock.ts";

export interface GithubActionsService {
  commitPush(
    caller: Caller,
    params: ParamsOf<"projects.commitPush">,
  ): Promise<ResultOf<"projects.commitPush">>;
  prCreate(caller: Caller, params: ParamsOf<"projects.prCreate">): Promise<ResultOf<"projects.prCreate">>;
  github(caller: Caller, projectId: string): Promise<ProjectGithubView>;
  checkLog(caller: Caller, params: ParamsOf<"projects.checkLog">): Promise<ResultOf<"projects.checkLog">>;
  /** A link or unlink changed what the project's lists mean. */
  invalidate(projectId: string): void;
  sendToSession(
    caller: Caller,
    params: ParamsOf<"projects.sendToSession">,
  ): Promise<ResultOf<"projects.sendToSession">>;
}

const Pull = z.object({ number: z.number().int().positive(), html_url: z.string().url().max(2048) });
const PULL_PERMISSIONS: Permissions = Object.freeze({ pull_requests: "write" });

/** A path segment-wise encoding: a branch keeps its slashes. */
const refPath = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");

export function createGithubActions(deps: {
  readonly core: GithubCore;
  readonly store: GithubProjectStore;
  readonly source: Pick<ProjectBoxSource, "box">;
  readonly audit: Pick<AuditPort, "append">;
  readonly clock: Clock;
  readonly sessions: GithubSessionsPort;
  /** The project's state without the lists (`GithubProjectsService.view`). */
  baseView(row: GithubProjectRow): ProjectGithubView;
  /** The ops of the bound box control; `internal` until it is bound. */
  ops(): BoxOps;
}): GithubActionsService {
  const { core, store, source } = deps;
  const lists = createLists({ core, clock: deps.clock });
  const send = createSend({ sessions: deps.sessions, lists });

  /** A live box project of the caller's. */
  function boxOf(caller: Caller, projectId: string): { root: string } {
    const box = source.box(projectId);
    if (!box || box.ownerId !== caller.userId || box.deleting) throw new PapError("not_found");
    return box;
  }
  function linkedOf(caller: Caller, projectId: string): { root: string; row: GithubProjectRow } {
    const box = boxOf(caller, projectId);
    const row = store.get(projectId);
    if (!row?.linked) throw new PapError("bad_request");
    return { root: box.root, row };
  }
  const record = (caller: Caller, reason: string, projectId: string): void =>
    deps.audit.append({
      ownerId: caller.userId,
      actor: caller.kind === "token" ? "token" : "user",
      kind: "policy",
      reason,
      detail: { projectId },
    });

  /** The upstream's default branch, read from the fork's own metadata (its parent), else the fork's. */
  async function forkBase(fork: GithubProjectRow["repository"]): Promise<string> {
    const found = await lists.branches(fork);
    return found.parent ?? found.own;
  }

  /** A token for this repository with `pull_requests: write` only, used once; a 422 (already open, bad head) is `conflict`. */
  async function openPull(
    repository: GithubProjectRow["repository"],
    pull: { title: string; body: string; head: string; base: string },
  ): Promise<z.output<typeof Pull>> {
    const minted = await core.tokens.mint(repository, PULL_PERMISSIONS);
    try {
      return await core.client.json(Pull, {
        method: "POST",
        path: `/repos/${repository}/pulls`,
        auth: { kind: "bearer", value: minted.token },
        body: pull,
      });
    } finally {
      await core.tokens.revoke(minted.token).catch(() => undefined);
    }
  }

  return {
    invalidate: lists.invalidate,
    async commitPush(caller, { projectId, message }) {
      assertBrowserCaller("projects.commitPush", caller);
      linkedOf(caller, projectId);
      const ops = deps.ops();
      // A clean tree commits nothing (`sha: null`): the push still goes, for commits made by hand.
      const { sha } = await ops.call(projectId, { name: "git.commit", message });
      const { branch } = await ops.call(projectId, { name: "git.push" });
      lists.invalidate(projectId);
      record(caller, "github_pushed", projectId);
      return { sha, branch };
    },
    async prCreate(caller, { projectId, title, body, base }) {
      assertBrowserCaller("projects.prCreate", caller);
      const { row } = linkedOf(caller, projectId);
      const ops = deps.ops();
      if (row.fork) {
        if (!row.upstream) throw new PapError("internal");
        // The fork's pull request is opened by the person on GitHub's compare page: the upstream's API is never called.
        const { branch } = await ops.call(projectId, { name: "git.push" });
        const into = base ?? (await forkBase(row.repository));
        const login = row.repository.split("/")[0] ?? "";
        lists.invalidate(projectId);
        record(caller, "github_pr_created", projectId);
        return {
          kind: "compare",
          url: `${core.client.webOrigin}/${row.upstream}/compare/${refPath(into)}...${login}:${refPath(branch)}`,
        };
      }
      // The daemon opens the pull request (R9): no `gh` runs in the box on a repository a session can write.
      const into = base ?? (await lists.branches(row.repository)).own;
      const { branch } = await ops.call(projectId, { name: "git.push" });
      const made = await openPull(row.repository, { title, body, head: branch, base: into });
      lists.invalidate(projectId);
      record(caller, "github_pr_created", projectId);
      return { kind: "created", number: made.number, url: made.html_url };
    },
    async github(caller, projectId) {
      boxOf(caller, projectId);
      const row = store.get(projectId);
      if (!row) return emptyView();
      const view = deps.baseView(row);
      if (!row.linked) return view;
      return { ...view, ...(await lists.lists(projectId, row.repository)) };
    },
    async checkLog(caller, { projectId, checkId }) {
      boxOf(caller, projectId);
      const row = store.get(projectId);
      if (!row?.linked) throw new PapError("not_found");
      return lists.log(row.repository, checkId);
    },
    async sendToSession(caller, { projectId, source: what, sessionId }) {
      assertBrowserCaller("projects.sendToSession", caller);
      const { root, row } = linkedOf(caller, projectId);
      return send.send(caller, { projectId, root, repository: row.repository }, what, sessionId);
    },
  };
}

function emptyView(): ProjectGithubView {
  return { link: null, key: "absent", clone: null, pulls: [], issues: [], releases: [], fetchedAt: null };
}
