import {
  type Caller,
  type ForgeKind,
  type IssueView,
  PapError,
  type ParamsOf,
  type ResultOf,
} from "@pap/contracts";
import type { ForgeOutcome } from "../../kernel/forge/cli.ts";
import type { Forge } from "../../kernel/forge/port.ts";
import {
  type IssueRef,
  issueAllowed,
  issueUrl,
  parseIssueUrl,
  type RemoteRef,
} from "../../kernel/forge/remote.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LaneConfig } from "./preview.ts";

/** What the project says about its forge: the facts `issueAllowed` judges a pasted link against (M9-RT-04). */
export interface ProjectForge {
  readonly remote: RemoteRef | null;
  readonly forge: ForgeKind | null;
}

type IssueAnswer = ResultOf<"lanes.issue">;
type Refusal = Extract<IssueAnswer, { ok: false }>["reason"];

/**
 * The reference a link names, only when it is a repository on github.com or on the project's own forge host. Anything
 * else is null, and no forge call is made for it.
 */
export function allowedRef(
  url: string,
  override: ForgeKind | undefined,
  project: ProjectForge,
): IssueRef | null {
  const ref = parseIssueUrl(url, override);
  return ref !== null && issueAllowed(ref, project) ? ref : null;
}

/**
 * The issue a token or a browser sends with `lanes.create` is re-judged here (M9R82): the link must parse for the forge
 * it names, be on an allowed host, and carry the number it claims.
 */
export function checkedIssue(issue: IssueView, project: ProjectForge): IssueRef {
  const ref = allowedRef(issue.url, issue.forge, project);
  if (ref === null || ref.kind !== issue.forge || ref.number !== issue.number)
    throw new PapError("bad_request");
  return ref;
}

const REFUSALS: Readonly<Partial<Record<ForgeOutcome, Refusal>>> = {
  forge_missing: "forge_missing",
  not_signed_in: "not_signed_in",
  not_found: "not_found",
};

export interface IssuesDeps {
  readonly config: Pick<LaneConfig, "preview">;
  forgeFor(kind: ForgeKind): Forge | null;
  readonly logger: Logger;
}

export interface Issues {
  /** `lanes.issue`: the issue behind a pasted link, read once from the project's own forge. */
  view(caller: Caller, params: ParamsOf<"lanes.issue">): Promise<IssueAnswer>;
}

export function createIssues(deps: IssuesDeps): Issues {
  return {
    async view(caller, params) {
      // `not_found` for a folder that is not the caller's project root.
      const project = await deps.config.preview(caller, params.projectRoot);
      const ref = allowedRef(params.url, project.forge ?? undefined, project);
      const forge = ref === null ? null : deps.forgeFor(ref.kind);
      if (ref === null || forge === null) return { ok: false, reason: "unsupported_url" };
      const read = await forge.viewIssue(ref, ref.number);
      if (!read.ok) {
        if (read.outcome === "timeout") throw new PapError("timeout");
        deps.logger.debug("lane_issue_not_read", { outcome: read.outcome });
        return { ok: false, reason: REFUSALS[read.outcome] ?? "failed" };
      }
      // The link the person sees is the one pap rebuilt, not the one the forge CLI printed.
      return { ok: true, issue: { ...read.value, forge: ref.kind, url: issueUrl(ref) } };
    },
  };
}
