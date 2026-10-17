import { promises as fs } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  HELPER_OPS,
  SUBAGENT_LIMITS,
  SubagentName,
  type SubagentProfile,
  type SubagentsProfilesResult,
  type SubagentsSkipped,
} from "@pap/contracts";
import { defineOp, type HelperContext } from "../ops.ts";
import { PiFileRefused, readPiFile } from "../pi-file.ts";
import { isTrusted } from "./models-open.ts";
import { offline } from "./offline.ts";

type Ctx = Pick<HelperContext, "agentDir" | "cwd">;
type Source = SubagentProfile["source"];

const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const cleaned = (raw: string, max: number): string =>
  raw
    .replace(CONTROL, " ")
    .trim()
    .slice(0, max)
    .replace(/[\ud800-\udbff]$/, "");

type Outcome = { profile: SubagentProfile } | { skip: keyof SubagentsSkipped } | null;

/**
 * One folder of Pi's agent files (the subagent example's format: front matter `name` and `description`, then the prompt).
 * The first `files` names in order are considered, so the 65th is not read. Each file that is considered and not listed is
 * counted by reason; a profile marked `longTerm` (pi-web's own kind) is left out on purpose and not counted.
 */
async function readFolder(
  folder: string,
  root: string,
  source: Source,
): Promise<{ profiles: SubagentProfile[]; cut: boolean; skipped: SubagentsSkipped }> {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const profiles: SubagentProfile[] = [];
  const skipped: SubagentsSkipped = { parse: 0, refused: 0, tooLarge: 0 };
  for (const fileName of candidates.slice(0, SUBAGENT_LIMITS.files)) {
    const outcome = await readOne(join(folder, fileName), root, source);
    if (outcome === null) continue;
    if ("profile" in outcome) profiles.push(outcome.profile);
    else skipped[outcome.skip] += 1;
  }
  return { profiles, cut: candidates.length > SUBAGENT_LIMITS.files, skipped };
}

/**
 * The size is checked first, from the file's metadata, so an oversized file is never read. A link that stays inside `root`
 * is accepted (`readPiFile` keeps every real path inside the root); one that leaves it, a FIFO or a dangling link is refused.
 */
async function readOne(path: string, root: string, source: Source): Promise<Outcome> {
  const info = await fs.stat(path).catch(() => null);
  if (info === null) return { skip: "refused" };
  if (info.size > SUBAGENT_LIMITS.fileBytes) return { skip: "tooLarge" };
  let text: string | null;
  try {
    ({ text } = await readPiFile(path, [root]));
  } catch (error) {
    return { skip: error instanceof PiFileRefused && error.reason === "too-large" ? "tooLarge" : "refused" };
  }
  if (text === null) return { skip: "refused" };
  if (Buffer.byteLength(text) > SUBAGENT_LIMITS.fileBytes) return { skip: "tooLarge" };
  let front: Record<string, unknown>;
  try {
    front = parseFrontmatter(text).frontmatter;
  } catch {
    return { skip: "parse" };
  }
  if (front["longTerm"] === true) return null;
  const name = SubagentName.safeParse(front["name"]);
  if (!name.success || typeof front["description"] !== "string") return { skip: "parse" };
  const description = cleaned(front["description"], SUBAGENT_LIMITS.description);
  if (description === "") return { skip: "parse" };
  return { profile: { name: name.data, description, source } };
}

/**
 * The profiles of the owner's Pi folder and, while Pi's trust store says `true` for the run's folder, of the project's
 * `.pi/agents`. A project file replaces a user file of the same name, as in Pi's own subagent example. Read offline (MC52).
 */
export async function listProfiles(ctx: Ctx): Promise<SubagentsProfilesResult> {
  return offline(async () => {
    const user = await readFolder(join(ctx.agentDir, "agents"), ctx.agentDir, "user");
    const real = ctx.cwd === undefined ? null : await fs.realpath(ctx.cwd).catch(() => null);
    const project =
      real !== null && isTrusted(ctx.agentDir, real)
        ? await readFolder(join(real, ".pi", "agents"), real, "project")
        : { profiles: [], cut: false, skipped: { parse: 0, refused: 0, tooLarge: 0 } };
    const byName = new Map<string, SubagentProfile>();
    for (const profile of [...user.profiles, ...project.profiles]) byName.set(profile.name, profile);
    const profiles = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const skipped = {
      parse: user.skipped.parse + project.skipped.parse,
      refused: user.skipped.refused + project.skipped.refused,
      tooLarge: user.skipped.tooLarge + project.skipped.tooLarge,
    };
    return { profiles, truncated: user.cut || project.cut, skipped };
  });
}

export const subagentProfilesOp = defineOp({
  params: HELPER_OPS["subagents.profiles"].params,
  run: (_params, ctx) => listProfiles(ctx),
});
