import {
  type CheckView,
  GITHUB_LIMITS,
  type GithubIssueView,
  PapError,
  type PullView,
  type ReleaseView,
  type RepoFullName,
} from "@pap/contracts";
import { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { GithubCore } from "./index.ts";
import type { Permissions } from "./tokens.ts";

/** What the lists and logs may do: read the repository's pulls, issues, checks and Actions. Never the box token, never the user's. */
export const READ_PERMISSIONS: Permissions = Object.freeze({
  contents: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  actions: "read",
  metadata: "read",
});
export const LIST_CACHE_MS = 60_000;
const CHECKS_AT_ONCE = 5;
const CACHE_MAX = 256;

const Text = z.string();
const Login = z.object({ login: z.string() }).nullable().optional();
const PullRaw = z.object({
  number: z.number().int().positive(),
  title: Text,
  html_url: Text,
  user: Login,
  draft: z.boolean().optional(),
  head: z.object({ ref: Text, sha: Text }),
});
const RunsRaw = z.object({
  check_runs: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      name: Text,
      status: Text,
      conclusion: Text.nullable().optional(),
    }),
  ),
});
const IssueRaw = z.object({
  number: z.number().int().positive(),
  title: Text,
  body: Text.nullable().optional(),
  html_url: Text,
  user: Login,
  labels: z.array(z.union([Text, z.object({ name: Text })])).optional(),
  pull_request: z.unknown().optional(),
});
const ReleaseRaw = z.object({
  tag_name: Text,
  name: Text.nullable().optional(),
  published_at: Text.nullable().optional(),
  html_url: Text,
  assets: z.array(z.object({ name: Text, browser_download_url: Text })).optional(),
});
const RepoRaw = z.object({
  default_branch: Text,
  parent: z.object({ default_branch: Text }).nullable().optional(),
});

export interface GithubLists {
  readonly pulls: PullView[];
  readonly issues: GithubIssueView[];
  readonly releases: ReleaseView[];
  /** ISO time of the fetch these lists come from. */
  readonly fetchedAt: string;
}

export interface ListsService {
  /** The cached lists (60 s), else fresh ones; when GitHub fails, the stale cache, else `github_unavailable`. */
  lists(projectId: string, repo: RepoFullName): Promise<GithubLists>;
  /** The last 64 KiB of the job's log. */
  log(repo: RepoFullName, checkId: string): Promise<{ text: string; truncated: boolean }>;
  /** `# title`, then the body, of one issue. */
  issueText(repo: RepoFullName, number: number): Promise<string>;
  /** The repository's own default branch, and its parent's when it is a fork. */
  branches(repo: RepoFullName): Promise<{ own: string; parent: string | null }>;
  /** A push or a pull request changed what the lists say. */
  invalidate(projectId: string): void;
}

const cut = (value: string, max: number): string => value.slice(0, max);
const stateOf = (status: string, conclusion: string | null | undefined): CheckView["state"] => {
  if (status !== "completed") return "running";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "failure";
    default:
      return "neutral";
  }
};

export function createLists(deps: { readonly core: GithubCore; readonly clock: Clock }): ListsService {
  const { core, clock } = deps;
  const cache = new Map<string, { repo: RepoFullName; at: number; value: GithubLists }>();

  async function read<S extends z.ZodType>(
    repo: RepoFullName,
    schema: S,
    path: string,
  ): Promise<z.output<S>> {
    const minted = await core.tokens.mint(repo, READ_PERMISSIONS);
    return core.client.json(schema, { path, auth: { kind: "bearer", value: minted.token } });
  }

  async function checksOf(repo: RepoFullName, sha: string): Promise<CheckView[]> {
    const runs = await read(
      repo,
      RunsRaw,
      `/repos/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=${GITHUB_LIMITS.list}`,
    );
    return runs.check_runs.slice(0, GITHUB_LIMITS.list).map((run) => ({
      id: String(run.id),
      name: cut(run.name, GITHUB_LIMITS.title),
      state: stateOf(run.status, run.conclusion),
    }));
  }

  async function fetchLists(repo: RepoFullName): Promise<GithubLists> {
    const per = `per_page=${GITHUB_LIMITS.list}`;
    const raw = await read(repo, z.array(PullRaw), `/repos/${repo}/pulls?state=open&${per}`);
    const pulls: PullView[] = [];
    for (let at = 0; at < Math.min(raw.length, GITHUB_LIMITS.list); at += CHECKS_AT_ONCE) {
      const batch = raw.slice(at, Math.min(at + CHECKS_AT_ONCE, GITHUB_LIMITS.list));
      const checks = await Promise.all(batch.map((pull) => checksOf(repo, pull.head.sha)));
      batch.forEach((pull, index) =>
        pulls.push({
          number: pull.number,
          title: cut(pull.title, GITHUB_LIMITS.title),
          url: pull.html_url,
          author: cut(pull.user?.login ?? "", GITHUB_LIMITS.name),
          draft: pull.draft === true,
          headRef: cut(pull.head.ref, GITHUB_LIMITS.name),
          checks: checks[index] ?? [],
        }),
      );
    }
    const issues = (await read(repo, z.array(IssueRaw), `/repos/${repo}/issues?state=open&${per}`))
      .filter((issue) => issue.pull_request === undefined)
      .slice(0, GITHUB_LIMITS.list)
      .map((issue): GithubIssueView => ({
        number: issue.number,
        title: cut(issue.title, GITHUB_LIMITS.title),
        url: issue.html_url,
        author: cut(issue.user?.login ?? "", GITHUB_LIMITS.name),
        labels: (issue.labels ?? [])
          .map((label) => cut(typeof label === "string" ? label : label.name, GITHUB_LIMITS.name))
          .slice(0, GITHUB_LIMITS.list),
      }));
    const releases = (
      await read(repo, z.array(ReleaseRaw), `/repos/${repo}/releases?per_page=${GITHUB_LIMITS.releases}`)
    )
      .slice(0, GITHUB_LIMITS.releases)
      .map((release): ReleaseView => ({
        tag: cut(release.tag_name, GITHUB_LIMITS.name),
        name: cut(release.name || release.tag_name, GITHUB_LIMITS.title),
        publishedAt: release.published_at ? cut(release.published_at, 64) : null,
        url: release.html_url,
        assets: (release.assets ?? [])
          .slice(0, GITHUB_LIMITS.list)
          .map((asset) => ({ name: cut(asset.name, GITHUB_LIMITS.name), url: asset.browser_download_url })),
      }));
    return { pulls, issues, releases, fetchedAt: new Date(clock.now()).toISOString() };
  }

  return {
    async lists(projectId, repo) {
      const found = cache.get(projectId);
      // A relink to another repository never shows the old one's lists.
      const hit = found?.repo === repo ? found : undefined;
      if (hit && clock.now() - hit.at < LIST_CACHE_MS) return hit.value;
      try {
        const value = await fetchLists(repo);
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(projectId, { repo, at: clock.now(), value });
        return value;
      } catch {
        if (hit) return hit.value;
        throw new PapError("github_unavailable");
      }
    },
    async log(repo, checkId) {
      if (!/^\d{1,20}$/.test(checkId)) throw new PapError("not_found");
      const minted = await core.tokens.mint(repo, READ_PERMISSIONS);
      return core.client.log(`/repos/${repo}/actions/jobs/${checkId}/logs`, {
        kind: "bearer",
        value: minted.token,
      });
    },
    async issueText(repo, number) {
      const issue = await read(repo, IssueRaw, `/repos/${repo}/issues/${number}`);
      return `# ${issue.title}\n\n${issue.body ?? ""}`;
    },
    async branches(repo) {
      const found = await read(repo, RepoRaw, `/repos/${repo}`);
      return { own: found.default_branch, parent: found.parent?.default_branch ?? null };
    },
    invalidate: (projectId) => void cache.delete(projectId),
  };
}
