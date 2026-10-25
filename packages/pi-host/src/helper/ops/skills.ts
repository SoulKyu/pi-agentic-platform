import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, type Skill, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  HELPER_OPS,
  SKILL_LIMITS,
  type SkillRowCode,
  type SkillsListResult,
  type SkillsSetInvocationResult,
  type SkillView,
} from "@pap/contracts/pi-host";
import type { z } from "zod";
import { setFrontmatterFlag } from "../frontmatter.ts";
import { within } from "../../policy/target-path.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import { PiFileRefused, readPiFile, writePiFile } from "../pi-file.ts";
import { guardFile, isTrusted } from "./models-open.ts";
import { offline } from "./offline.ts";

type Ctx = Pick<HelperContext, "agentDir" | "home" | "cwd">;
type SetParams = z.infer<(typeof HELPER_OPS)["skills.setInvocation"]["params"]>;

const KEY = "disable-model-invocation";
/** M7R111: a skill file this large is not rewritten. */
const SKILL_FILE_MAX_BYTES = 256 * 1024;
/** The list leaves the helper in one record: it is cut under the page bound, with the flag, like every list (M2R54). */
const LIST_MAX_BYTES = 900_000;
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const clip = (raw: string, max: number): string =>
  raw
    .replace(CONTROL, "")
    .slice(0, max)
    .replace(/[\ud800-\udbff]$/, "");

interface Listing {
  readonly skills: readonly Skill[];
  /** The trusted project folder (real path), or null when there is none or it is not trusted. */
  readonly project: string | null;
}

/**
 * The skills Pi's own loader finds for the folder, with no extension loaded (M7R110). A project is read only while Pi's
 * trust store says `true`; otherwise the agent directory stands in for the folder and a project skill is dropped anyway.
 */
async function load(ctx: Ctx): Promise<Listing> {
  let project: string | null = null;
  if (ctx.cwd !== undefined) {
    const real = await fs.realpath(ctx.cwd).catch(() => null);
    if (real === null) throw new HelperOpError("bad_params", "cwd");
    if (isTrusted(ctx.agentDir, real)) project = real;
  }
  const folder = project ?? ctx.agentDir;
  // The settings files the loader reads first are guarded like `openSettings` guards them: a FIFO or a link out is refused, never read (MC55).
  await guardFile(join(ctx.agentDir, "settings.json"), [ctx.agentDir, ctx.home]);
  if (project !== null) await guardFile(join(project, ".pi", "settings.json"), [project]);
  const settingsManager = SettingsManager.create(folder, ctx.agentDir, { projectTrusted: project !== null });
  const loader = new DefaultResourceLoader({
    cwd: folder,
    agentDir: ctx.agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  // Offline (MC52): a read never installs a missing package; it is simply not listed.
  await offline(() => loader.reload({ resolveProjectTrust: async () => project !== null }));
  const skills = loader
    .getSkills()
    .skills.filter((skill) => project !== null || skill.sourceInfo.scope !== "project");
  return { skills, project };
}

function scopeOf(skill: Skill): SkillView["scope"] {
  const { scope, origin } = skill.sourceInfo;
  if (origin === "package") return "package";
  return scope === "user" || scope === "project" ? scope : "other";
}

const byNameThenPath = (a: SkillView, b: SkillView): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export async function listSkills(ctx: Ctx): Promise<SkillsListResult> {
  const { skills } = await load(ctx);
  const views: SkillView[] = [];
  let truncated = false;
  for (const skill of skills) {
    const name = clip(skill.name, SKILL_LIMITS.name);
    const path = skill.filePath;
    // A name or path the contract cannot carry is not listed, and the list says it is incomplete.
    if (name === "" || !path.startsWith("/") || path.length > SKILL_LIMITS.path || path.includes("\0")) {
      truncated = true;
      continue;
    }
    views.push({
      name,
      description: clip(skill.description, SKILL_LIMITS.description),
      path,
      scope: scopeOf(skill),
      disableModelInvocation: skill.disableModelInvocation,
    });
  }
  views.sort(byNameThenPath);
  const kept: SkillView[] = [];
  let bytes = 64;
  for (const view of views) {
    bytes += Buffer.byteLength(JSON.stringify(view)) + 1;
    if (kept.length >= SKILL_LIMITS.list || bytes > LIST_MAX_BYTES) {
      truncated = true;
      break;
    }
    kept.push(view);
  }
  return { skills: kept, truncated };
}

type Row = SkillsSetInvocationResult["results"][number];
const refused = (path: string, code: SkillRowCode): Row => ({ path, ok: false, code });

/** The loader lists the file, so it exists as a skill; it is switched only if it is still a plain file inside its own folder. */
async function switchOne(
  item: SetParams["items"][number],
  skill: Skill | undefined,
  project: string | null,
  confirmProtected: boolean,
): Promise<Row> {
  if (skill === undefined) return refused(item.path, "not_found");
  const real = await fs.realpath(skill.filePath).catch(() => skill.filePath);
  const inProject =
    skill.sourceInfo.scope === "project" ||
    (project !== null && (within(project, skill.filePath) || within(project, real)));
  if (inProject && !confirmProtected) return refused(item.path, "protected_path");
  if (!skill.filePath.endsWith(".md")) return refused(item.path, "config_path_refused");
  const roots = [dirname(skill.filePath)];
  try {
    const { text } = await readPiFile(skill.filePath, roots);
    if (text === null) return refused(item.path, "not_found");
    if (Buffer.byteLength(text) > SKILL_FILE_MAX_BYTES) return refused(item.path, "config_invalid");
    const next = setFrontmatterFlag(text, KEY, item.disabled);
    if (next === null) return refused(item.path, "config_invalid");
    if (next !== text) await writePiFile(skill.filePath, next, { roots, mode: 0o644, keepMode: true });
    return { path: item.path, ok: true };
  } catch (error) {
    return refused(item.path, error instanceof PiFileRefused ? "config_path_refused" : "write_failed");
  }
}

/**
 * Switches `disable-model-invocation` on files the loader listed for this folder (M7R111): a path that is not in that list
 * is `not_found` and never opened. A project skill needs the protected-file confirmation (M7R133). One row failing leaves the others.
 */
export async function setInvocation(params: SetParams, ctx: Ctx): Promise<SkillsSetInvocationResult> {
  const { skills, project } = await load(ctx);
  const listed = new Map(skills.map((skill) => [skill.filePath, skill]));
  const results: Row[] = [];
  for (const item of params.items)
    results.push(await switchOne(item, listed.get(item.path), project, params.confirmProtected === true));
  return { results };
}

export const skillsListOp = defineOp({
  params: HELPER_OPS["skills.list"].params,
  run: (_params, ctx) => listSkills(ctx),
});
export const skillsSetInvocationOp = defineOp({
  params: HELPER_OPS["skills.setInvocation"].params,
  run: (params, ctx) => setInvocation(params, ctx),
});
