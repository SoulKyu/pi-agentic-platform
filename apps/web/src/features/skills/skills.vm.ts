import {
  SKILLS_CLI,
  type PluginView,
  type PluginSetEnabledResult,
  type SkillRowCode,
  type SkillView,
} from "@pap/contracts";
import { errorKey, t } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { parseUrl } from "../../lib/parse-url.ts";
import { RpcError } from "../../runtime/index.ts";

export { escapeHidden };

/** The project the owner came from: its folder is what the lists and project writes name. */
export interface ProjectRef {
  readonly root: string;
  readonly name: string;
}

/** Where an install goes: the owner's Pi folder, or the project (M7R140). */
export type InstallScope = "global" | "project";

export type SkillAction = "list" | "write" | "install" | "search" | "update";

/** The scope an install form starts on: the project the owner came from, else all projects (M7R118). */
export const defaultScope = (project: ProjectRef | null): InstallScope =>
  project === null ? "global" : "project";

/** The exact command pap runs, from the pinned constant of the contracts: `-g` only for all projects (M7R140). */
export function installCommand(source: string, scope: InstallScope): string {
  const named = source.trim() === "" ? "o/r" : source.trim();
  return `npx ${SKILLS_CLI} add ${named} -y --agent pi${scope === "global" ? " -g" : ""}`;
}

/** A link from untrusted text opens only when it is an `https:` address. */
export function safeLink(url: string | null): string | null {
  return url !== null && url.startsWith("https://") && parseUrl(url) !== null ? url : null;
}

export interface GroupSwitch {
  /** On only while every row is on. */
  readonly on: boolean;
  readonly enabled: number;
  readonly total: number;
}

export function groupSwitch(rows: ReadonlyArray<{ readonly on: boolean }>): GroupSwitch {
  const enabled = rows.filter((row) => row.on).length;
  return { on: rows.length > 0 && enabled === rows.length, enabled, total: rows.length };
}

export type SkillGroupId = "user" | "project" | "other";

/** Skills by where they live: the owner's folder, the project, and every other source (packages). */
export function skillGroups(
  skills: readonly SkillView[],
): ReadonlyArray<{ readonly id: SkillGroupId; readonly rows: readonly SkillView[] }> {
  const idOf = (skill: SkillView): SkillGroupId =>
    skill.scope === "user" || skill.scope === "project" ? skill.scope : "other";
  return (["user", "project", "other"] as const).map((id) => ({
    id,
    rows: skills.filter((skill) => idOf(skill) === id),
  }));
}

export const pluginKey = (plugin: Pick<PluginView, "scope" | "source">): string =>
  `${plugin.scope}/${plugin.source}`;

const failureCode = (failure: unknown): string => (failure instanceof RpcError ? failure.code : "internal");

/** What a failed call says: a fixed text per refusal that means something here. The server's message never shows (C §4.1). */
export function skillsFailureText(failure: unknown, action: SkillAction): string {
  const code = failureCode(failure);
  switch (code) {
    case "timeout":
    case "connection_lost":
      return action === "list" || action === "search"
        ? t("settingsSkills.err.slow")
        : t("settingsSkills.err.unknownOutcome");
    case "forbidden":
      return t("settingsSkills.err.untrusted");
    case "capacity":
      return t("settingsSkills.err.capacity");
    case "helper_failed":
      return t(action === "install" ? "settingsSkills.err.installFailed" : "settingsSkills.err.helper");
    case "bad_request":
      return action === "install" ? t("settingsSkills.err.badSource") : t(errorKey(code));
  }
  return t(errorKey(code));
}

export function skillRowText(name: string, code: SkillRowCode | undefined): string {
  const label = escapeHidden(name);
  switch (code) {
    case "not_found":
      return t("settingsSkills.row.notFound", { name: label });
    case "protected_path":
      return t("settingsSkills.row.protected", { name: label });
    case "config_invalid":
    case "config_path_refused":
      return t("settingsSkills.row.config", { name: label });
    default:
      return t("settingsSkills.row.failed", { name: label });
  }
}

export function pluginRowText(
  source: string,
  code: PluginSetEnabledResult["results"][number]["code"],
): string {
  const label = escapeHidden(source);
  switch (code) {
    case "not_found":
      return t("settingsSkills.plugin.notFound", { name: label });
    case "filtered":
      return t("settingsSkills.plugin.filtered", { name: label });
    default:
      return t("settingsSkills.row.failed", { name: label });
  }
}
