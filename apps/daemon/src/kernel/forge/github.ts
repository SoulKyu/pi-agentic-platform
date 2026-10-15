import type { z } from "zod";
import { FORGE_CREATE_TIMEOUT_MS, FORGE_TIMEOUT_MS, type ForgeResult, forgeEnv, runForge } from "./cli.ts";
import { FIND_LIMIT, GhIssue, GhPr, GhPrList, issueViewOf, prViewOf } from "./github-json.ts";
import type { CreatePrInput, Forge, ForgeDeps } from "./port.ts";
import type { RemoteRef } from "./remote.ts";

const REPO = /^[A-Za-z0-9_.-]{1,253}(?:\/[A-Za-z0-9_.-]{1,100}){2,8}$/;
const BRANCH_ARG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export const PR_JSON = "number,url,state,isDraft,mergeable,statusCheckRollup";
export const PR_LIST_JSON = "number,url,state,isDraft,isCrossRepository";
export const ISSUE_JSON = "number,title,body,state,labels,url";

/** `host/owner/repo`: gh's `[HOST/]OWNER/REPO`, built from a parsed remote only (no `.` or `..` segment). */
function repoArg(repo: RemoteRef): string {
  const value = `${repo.host}/${repo.path}`;
  if (!REPO.test(value) || value.split("/").some((part) => part === "." || part === ".."))
    throw new Error("forge argument refused");
  return value;
}
function branchArg(branch: string): string {
  if (!BRANCH_ARG.test(branch)) throw new Error("forge argument refused");
  return branch;
}
function numberArg(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("forge argument refused");
  return String(n);
}

/** Every value is joined to its flag with `=` (M9R46); the PR body goes on stdin. */
export const githubArgs = {
  prFind: (repo: RemoteRef, head: string): string[] => [
    "pr",
    "list",
    `--repo=${repoArg(repo)}`,
    `--head=${branchArg(head)}`,
    "--state=all",
    `--json=${PR_LIST_JSON}`,
    `--limit=${FIND_LIMIT}`,
  ],
  prCreate: (
    repo: RemoteRef,
    head: string,
    base: string | undefined,
    title: string,
    draft: boolean,
  ): string[] => [
    "pr",
    "create",
    `--repo=${repoArg(repo)}`,
    `--head=${branchArg(head)}`,
    ...(base === undefined ? [] : [`--base=${branchArg(base)}`]),
    `--title=${title}`,
    "--body-file=-",
    ...(draft ? ["--draft"] : []),
  ],
  prView: (repo: RemoteRef, number: number): string[] => [
    "pr",
    "view",
    numberArg(number),
    `--repo=${repoArg(repo)}`,
    `--json=${PR_JSON}`,
  ],
  issueView: (repo: RemoteRef, number: number): string[] => [
    "issue",
    "view",
    numberArg(number),
    `--repo=${repoArg(repo)}`,
    `--json=${ISSUE_JSON}`,
  ],
};

/** `gh pr create` prints the new pull request's URL on its last line. */
const CREATED_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_./-]+\/pull\/(\d{1,9})$/;

export function githubForge(deps: ForgeDeps): Forge {
  const bin = deps.bin ?? "gh";
  const call = async (op: string, args: string[], timeoutMs: number, input?: string) =>
    runForge(bin, args, {
      cwd: deps.forgeDir,
      env: forgeEnv(deps.env, deps.forgeDir),
      input,
      timeoutMs,
      logger: deps.logger,
      clock: deps.clock,
      forge: "github",
      op,
    });
  /** Runs, parses the JSON as untrusted content and maps it; a parse failure is `failed`. */
  const json = async <S extends z.ZodType, T>(
    op: string,
    args: string[],
    schema: S,
    map: (value: z.infer<S>) => T,
  ): Promise<ForgeResult<T>> => {
    const run = await call(op, args, deps.timeoutMs ?? FORGE_TIMEOUT_MS);
    if (!run.ok) return run;
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      deps.logger.warn("forge_failed", { forge: "github", op, outcome: "failed", code: "bad_json" });
      return { ok: false, outcome: "failed" };
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      deps.logger.warn("forge_failed", { forge: "github", op, outcome: "failed", code: "bad_shape" });
      return { ok: false, outcome: "failed" };
    }
    return { ok: true, value: map(checked.data as z.infer<S>) };
  };
  return {
    kind: "github",
    async findPr(repo, head) {
      const found = await json("find_pr", githubArgs.prFind(repo, head), GhPrList, (list) => list);
      if (!found.ok) return found;
      // `--head` matches the branch name across forks: only the repository's own pull requests count.
      const first = found.value.find((entry) => !entry.isCrossRepository);
      if (first !== undefined)
        return { ok: true, value: prViewOf({ ...first, mergeable: undefined }, deps.clock.now()) };
      // A full list of forks may hide the own pull request past the limit: not "none", or a second one would be made.
      if (found.value.length >= FIND_LIMIT) {
        deps.logger.warn("forge_failed", {
          forge: "github",
          op: "find_pr",
          outcome: "failed",
          code: "list_full",
        });
        return { ok: false, outcome: "failed" };
      }
      return { ok: true, value: null };
    },
    viewPr: (repo, number) =>
      json("view_pr", githubArgs.prView(repo, number), GhPr, (pr) => prViewOf(pr, deps.clock.now())),
    viewIssue: (repo, number) => json("view_issue", githubArgs.issueView(repo, number), GhIssue, issueViewOf),
    async createPr(repo: RemoteRef, input: CreatePrInput) {
      const args = githubArgs.prCreate(repo, input.head, input.base, input.title, input.draft);
      const run = await call("create_pr", args, deps.createTimeoutMs ?? FORGE_CREATE_TIMEOUT_MS, input.body);
      if (!run.ok) return run;
      const url = run.stdout.trim().split("\n").pop() ?? "";
      const match = CREATED_URL.exec(url);
      if (match === null) {
        deps.logger.warn("forge_failed", {
          forge: "github",
          op: "create_pr",
          outcome: "failed",
          code: "bad_url",
        });
        return { ok: false, outcome: "failed" };
      }
      return {
        ok: true,
        value: {
          number: Number(match[1]),
          url,
          state: "open",
          draft: input.draft,
          conflicts: null,
          checks: null,
          checkedAt: deps.clock.now(),
          error: null,
        },
      };
    },
  };
}
