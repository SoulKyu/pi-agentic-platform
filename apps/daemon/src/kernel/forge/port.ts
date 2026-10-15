import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ForgeKind, IssueView, PrView } from "@pap/contracts";
import type { Clock } from "../clock.ts";
import type { EnvSource } from "../child-env.ts";
import type { Logger } from "../logger.ts";
import type { ForgeResult } from "./cli.ts";
import { githubForge } from "./github.ts";
import type { RemoteRef } from "./remote.ts";

export interface CreatePrInput {
  head: string;
  /** Absent for a commit base: the forge takes its default branch. */
  base?: string;
  title: string;
  body: string;
  draft: boolean;
}

/** What a forge answers; each call is one CLI run from the empty forge folder (M9R46). */
export interface Forge {
  readonly kind: ForgeKind;
  /** The newest pull request of the head branch, or null. */
  findPr(repo: RemoteRef, head: string): Promise<ForgeResult<PrView | null>>;
  createPr(repo: RemoteRef, input: CreatePrInput): Promise<ForgeResult<PrView>>;
  viewPr(repo: RemoteRef, number: number): Promise<ForgeResult<PrView>>;
  viewIssue(repo: RemoteRef, number: number): Promise<ForgeResult<IssueView>>;
}

export interface ForgeDeps {
  /** The daemon's environment; `forgeEnv` keeps an allowlist of it. */
  env: EnvSource;
  /** `$PAP_HOME/tmp/forge`: empty, 0700. */
  forgeDir: string;
  logger: Logger;
  clock: Clock;
  /** The CLI to start (default `gh`, found on the child's absolute PATH). */
  bin?: string;
  timeoutMs?: number;
  createTimeoutMs?: number;
}

/** GitHub only for now (owner m9q5): GitLab and Gitea have no adapter. */
export function forgeFor(kind: ForgeKind, deps: ForgeDeps): Forge | null {
  return kind === "github" ? githubForge(deps) : null;
}

/**
 * `$PAP_HOME/tmp/forge`, created 0700 and answered as its real path: the CLI's git children stop at the folder's parent
 * through a lexical `GIT_CEILING_DIRECTORIES`, which a symlinked folder would slip past (Task 14).
 */
export function prepareForgeDir(papHome: string): string {
  const dir = join(papHome, "tmp", "forge");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = realpathSync(dir);
  chmodSync(real, 0o700);
  return real;
}
