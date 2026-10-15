import type { ForgeKind, LaneView } from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";

export const PR_REFUSED = {
  forge_missing: "laneCommit.pr.refused.forge_missing",
  not_signed_in: "laneCommit.pr.refused.not_signed_in",
  unsupported_remote: "laneCommit.pr.refused.unsupported_remote",
  not_pushed: "laneCommit.pr.refused.not_pushed",
  failed: "laneCommit.pr.refused.failed",
} as const satisfies Record<string, MessageKey>;

export const FORGE_NAME = {
  github: "laneCommit.pr.forge.github",
  gitlab: "laneCommit.pr.forge.gitlab",
  gitea: "laneCommit.pr.forge.gitea",
} as const satisfies Record<ForgeKind, MessageKey>;

/** A forge's answer is not trusted to be a link: only an https address opens (M9R92). */
export function openUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export const PR_TITLE_MAX = 256;

/** The form starts from the lane: its title (its branch when it has none). The daemon keeps no description to offer. */
export function prFormDefaults(lane: Pick<LaneView, "title" | "branch">): {
  title: string;
  body: string;
  draft: boolean;
} {
  return { title: (lane.title || lane.branch).slice(0, PR_TITLE_MAX), body: "", draft: false };
}

/** What to do about the forge, when the lane's forge or the last answer says it cannot help (M9R92, owner m9q5). */
export function forgeNotice(
  lane: Pick<LaneView, "forge">,
  reason:
    "forge_missing" | "not_signed_in" | "unsupported_remote" | "not_pushed" | "failed" | "not_found" | null,
): MessageKey | null {
  if (lane.forge === "gitlab" || lane.forge === "gitea" || reason === "unsupported_remote") {
    return "laneCommit.pr.hint.unsupported";
  }
  if (reason === "forge_missing" || reason === "not_signed_in") return "laneCommit.pr.hint.gh";
  return null;
}
