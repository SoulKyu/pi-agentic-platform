import { LANE_LIMITS, type LaneView, type VcsFile } from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";

export const COMMIT_REFUSED = {
  nothing_to_commit: "laneCommit.refused.nothing_to_commit",
  identity_missing: "laneCommit.refused.identity_missing",
  conflicted: "laneCommit.refused.conflicted",
  failed: "laneCommit.refused.failed",
} as const satisfies Record<string, MessageKey>;

export const PUSH_REFUSED = {
  repo_config: "laneCommit.push.refused.repo_config",
  rejected: "laneCommit.push.refused.rejected",
  auth: "laneCommit.push.refused.auth",
  network: "laneCommit.push.refused.network",
  no_remote: "laneCommit.push.refused.no_remote",
  unsupported_remote: "laneCommit.push.refused.unsupported_remote",
  failed: "laneCommit.push.refused.failed",
} as const satisfies Record<string, MessageKey>;

export const SUGGEST_REFUSED = {
  nothing: "laneCommit.suggest.refused.nothing",
  no_session: "laneCommit.suggest.refused.no_session",
  model_failed: "laneCommit.suggest.refused.model_failed",
} as const satisfies Record<string, MessageKey>;

/** Over this many paths the daemon refuses the call: the bar says so before it is sent. */
export const MAX_COMMIT_PATHS = LANE_LIMITS.commitPaths;

/** A repository path (raw bytes from git) as text: hidden and bidi characters are written as escapes. */
export const pathText = (file: Pick<VcsFile, "path" | "oldPath">): string =>
  file.oldPath === null
    ? escapeHidden(file.path)
    : `${escapeHidden(file.oldPath)} → ${escapeHidden(file.path)}`;

/** The ticked files' paths for `lanes.commit`: a renamed file also sends its old path, so the removal is staged. */
export function commitPaths(files: readonly VcsFile[], unticked: ReadonlySet<string>): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (unticked.has(file.path)) continue;
    paths.add(file.path);
    if (file.oldPath !== null) paths.add(file.oldPath);
  }
  return [...paths];
}

export const tickedCount = (files: readonly VcsFile[], unticked: ReadonlySet<string>): number =>
  files.filter((file) => !unticked.has(file.path)).length;

export interface PushModel {
  /** Commits that would go: the ones not on the upstream once a first push set one, else those ahead of the base. */
  readonly count: number | null;
  /** `host/path` of where a push would really go (never the origin's identity), or null. */
  readonly target: string | null;
  readonly label: { readonly key: MessageKey; readonly vars: Record<string, string | number> };
  /** Why there is no target, when there is none. */
  readonly whyNot: MessageKey | null;
}

/** Push ↑n → host/path (M9R91): the target is `pushRemote`, shown before the first push; without one the button says why. */
export function pushModel(lane: Pick<LaneView, "facts" | "pushRemote" | "remote">): PushModel {
  const count = lane.facts === null ? null : (lane.facts.unpushed ?? lane.facts.ahead);
  const shown = count ?? "—";
  const target =
    lane.pushRemote === null ? null : escapeHidden(`${lane.pushRemote.host}/${lane.pushRemote.path}`);
  if (target === null) {
    return {
      count,
      target,
      label: { key: "laneCommit.push.plain", vars: { n: shown } },
      whyNot: lane.remote === null ? PUSH_REFUSED.no_remote : PUSH_REFUSED.unsupported_remote,
    };
  }
  return { count, target, label: { key: "laneCommit.push.to", vars: { n: shown, target } }, whyNot: null };
}
