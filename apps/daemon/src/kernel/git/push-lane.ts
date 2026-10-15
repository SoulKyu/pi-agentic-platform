import type { Logger } from "../logger.ts";
import { parseRemote, type RemoteRef } from "../forge/remote.ts";
import { ORIGIN_URLS_ARGS, PUSH_SCAN_ARGS } from "./exec.ts";
import { pushTarget, type PushTarget } from "./push-target.ts";
import { repositoryKeys } from "./repo-scan.ts";
import { GitError, type GitRunner } from "./runner.ts";

/** Where a lane's git runs: its root and the git dir pap stored for it (MC3 I3). A main checkout has no git dir. */
export interface PushLane {
  readonly root: string;
  readonly gitDir?: string;
}

export interface PushLaneDeps {
  readonly git: GitRunner;
  readonly logger: Logger;
  /** `Config.testGitProtocols` includes `file`: the test seam, never true in production (M9R10). */
  readonly allowFile: boolean;
}

export type PushRefusal =
  "no_remote" | "unsupported_remote" | "repo_config" | "rejected" | "auth" | "network" | "failed";
export type PushOutcome =
  { readonly ok: true; readonly target: RemoteRef } | { readonly ok: false; readonly reason: PushRefusal };

export const PUSH_TIMEOUT_MS = 120_000;
const KEYS_LOGGED = 8;

const linesOf = (stdout: Buffer): string[] =>
  stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");

/**
 * What the log may say about a repository key: its first and last segment. The middle of `url.<base>.insteadof`,
 * `credential.<url>.helper` and `http.<url>.proxy` is a URL, and a URL can carry a token (MC57).
 */
export function keyShape(key: string): string {
  const parts = key.split(".");
  return parts.length < 2 ? key.slice(0, 40) : `${parts[0]}.${parts.at(-1)}`.slice(0, 60);
}

export interface RemoteRead {
  /** The forge identity: the one `remote.origin.url` as configured, before any `insteadOf`; null when it is not a forge URL. */
  readonly origin: RemoteRef | null;
  readonly target: PushTarget;
}

/** A timeout is an unknown outcome and a full queue is `capacity`: they pass through. Any other git failure is the caller's `failed`. */
function rethrowable(error: unknown): boolean {
  return !(error instanceof GitError) || error.kind === "timeout";
}

/**
 * The whole read half of a push, from the LANE root with the stored git dir (MC4): the repository scan, the origin
 * URLs as configured and every real push URL. A non-empty scan refuses before `pushTarget` is asked, so a `pushurl`
 * in the lane's own `config.worktree` is seen by the same `git` that will push. Used by the push button's fact, the
 * preview and `lanes.push`.
 */
export async function readPushTarget(deps: PushLaneDeps, lane: PushLane): Promise<RemoteRead> {
  const options = lane.gitDir === undefined ? {} : { gitDir: lane.gitDir };
  const { git, logger } = deps;
  try {
    const scan = await git.run(lane.root, [...PUSH_SCAN_ARGS], { ...options, okCodes: [0, 1] });
    const origin = await git.run(lane.root, [...ORIGIN_URLS_ARGS], { ...options, okCodes: [0, 1] });
    // `get-url` exits 2 when `origin` does not exist.
    const push = await git.run(lane.root, ["remote", "get-url", "--push", "--all", "origin"], {
      ...options,
      okCodes: [0, 2],
    });
    const originUrls = linesOf(origin.stdout);
    const identity = originUrls.length === 1 ? parseRemote(originUrls[0] as string) : null;
    const keys = repositoryKeys(scan.stdout);
    if (keys.length > 0) {
      logger.warn("push_refused", {
        reason: "repo_config",
        keys: [...new Set(keys.map(keyShape))].slice(0, KEYS_LOGGED),
        count: keys.length,
      });
      return { origin: identity, target: { ok: false, reason: "repo_config" } };
    }
    return {
      origin: identity,
      target: pushTarget({ originUrls, pushUrls: linesOf(push.stdout), allowFile: deps.allowFile }),
    };
  } catch (error) {
    if (rethrowable(error)) throw error;
    return { origin: null, target: { ok: false, reason: "repo_config" } };
  }
}

const REJECTED = /(?:^|\n)!\t|\[rejected\]|non-fast-forward|fetch first/;
const AUTH =
  /Authentication failed|Permission denied \(publickey|could not read Username|terminal prompts disabled|error: 403/;
const NETWORK = /Could not resolve host|Connection refused|timed out|Network is unreachable|unable to access/;

/** The refusal a finished `push --porcelain` stands for, or null when it succeeded (M9R69). */
export function classifyPush(run: {
  code: number;
  stdout: string;
  stderr: string;
}): Exclude<PushRefusal, "no_remote" | "unsupported_remote" | "repo_config"> | null {
  if (run.code === 0) return null;
  const text = `${run.stdout}\n${run.stderr}`;
  if (REJECTED.test(text)) return "rejected";
  if (AUTH.test(text)) return "auth";
  if (NETWORK.test(text)) return "network";
  return "failed";
}

/**
 * The one push sequence (MC4, M9R69), also Task 18a's: the reads above, then the push of exactly the lane's branch to
 * `origin`, under the remote profile. The target answered is the one the reads validated. Throws `GitError("timeout")`
 * when the outcome of the push is unknown.
 */
export async function pushLane(
  deps: PushLaneDeps,
  lane: PushLane & { readonly gitDir: string; readonly branch: string },
): Promise<PushOutcome> {
  const read = await readPushTarget(deps, lane);
  if (!read.target.ok) return { ok: false, reason: read.target.reason };
  const spec = `refs/heads/${lane.branch}:refs/heads/${lane.branch}`;
  let run: Awaited<ReturnType<GitRunner["run"]>>;
  try {
    run = await deps.git.run(lane.root, ["push", "--porcelain", "--set-upstream", "origin", spec], {
      gitDir: lane.gitDir,
      profile: "remote",
      timeoutMs: PUSH_TIMEOUT_MS,
      okCodes: [0, 1, 128],
      keepStderr: true,
    });
  } catch (error) {
    if (rethrowable(error)) throw error;
    return { ok: false, reason: "failed" };
  }
  const refusal = classifyPush({
    code: run.code,
    stdout: run.stdout.toString("utf8"),
    stderr: run.stderr ?? "",
  });
  if (refusal !== null) {
    deps.logger.warn("push_refused", { reason: refusal, code: run.code });
    return { ok: false, reason: refusal };
  }
  return { ok: true, target: read.target.target };
}
