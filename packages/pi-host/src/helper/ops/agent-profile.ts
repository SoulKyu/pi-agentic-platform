import { promises as fs } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  HELPER_OPS,
  SUBAGENT_LIMITS,
  SubagentName,
  type SubagentProfileFile,
  ToolName,
} from "@pap/contracts";
import { defineOp, HelperOpError, type HelperContext } from "../ops.ts";
import { readPiFile } from "../pi-file.ts";
import { isTrusted } from "./models-open.ts";
import { offline } from "./offline.ts";

type Ctx = Pick<HelperContext, "agentDir" | "cwd">;
type Source = SubagentProfileFile["source"];

const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const MAX_TOOLS = 32;
const MAX_MODEL = 128;

/** The `tools` line of a Pi agent file: a comma list (or a YAML list); a name that is not a tool name is dropped. */
function toolsOf(raw: unknown): string[] | null {
  const items = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
  const names = items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => ToolName.safeParse(item).success);
  return names.length === 0 ? null : [...new Set(names)].slice(0, MAX_TOOLS);
}

function modelOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(CONTROL, " ").trim();
  return text === "" || text.length > MAX_MODEL ? null : text;
}

/** One agent file read whole, or null when it is not a profile pap lists (the same rules as the list). */
async function parseOne(path: string, root: string, source: Source): Promise<SubagentProfileFile | null> {
  const info = await fs.stat(path).catch(() => null);
  if (info === null || info.size > SUBAGENT_LIMITS.fileBytes) return null;
  let text: string | null;
  try {
    ({ text } = await readPiFile(path, [root]));
  } catch {
    return null;
  }
  if (text === null || Buffer.byteLength(text) > SUBAGENT_LIMITS.fileBytes) return null;
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(text);
  } catch {
    return null;
  }
  const front: Record<string, unknown> = parsed.frontmatter;
  if (front["longTerm"] === true) return null;
  const name = SubagentName.safeParse(front["name"]);
  if (!name.success || typeof front["description"] !== "string") return null;
  const description = front["description"].replace(CONTROL, " ").trim().slice(0, SUBAGENT_LIMITS.description);
  if (description === "") return null;
  return {
    name: name.data,
    description,
    source,
    tools: toolsOf(front["tools"]),
    model: modelOf(front["model"]),
    prompt: parsed.body,
  };
}

/**
 * The files of one folder whose front-matter name is `name`. The first `files` names in order are considered, as in the list.
 * Two matches are an ambiguity the helper refuses, whichever order they come in: one is never picked silently.
 */
async function matchIn(
  folder: string,
  root: string,
  source: Source,
  name: string,
): Promise<SubagentProfileFile | null> {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, SUBAGENT_LIMITS.files);
  const found: SubagentProfileFile[] = [];
  for (const fileName of candidates) {
    const profile = await parseOne(join(folder, fileName), root, source);
    if (profile?.name === name) found.push(profile);
  }
  if (found.length > 1) throw new HelperOpError("conflict", "two agent files in one folder have this name");
  return found[0] ?? null;
}

/**
 * One profile whole (29b, carry 1): the project's file while Pi trusts the project, else the user's; the name comes from the
 * front matter. Read offline, links never followed out of the folder, like the list.
 */
export async function readProfile(ctx: Ctx, name: string): Promise<SubagentProfileFile> {
  return offline(async () => {
    const real = ctx.cwd === undefined ? null : await fs.realpath(ctx.cwd).catch(() => null);
    const project =
      real !== null && isTrusted(ctx.agentDir, real)
        ? await matchIn(join(real, ".pi", "agents"), real, "project", name)
        : null;
    const found = project ?? (await matchIn(join(ctx.agentDir, "agents"), ctx.agentDir, "user", name));
    if (found === null) throw new HelperOpError("not_found");
    return found;
  });
}

export const subagentProfileOp = defineOp({
  params: HELPER_OPS["subagents.profile"].params,
  run: (params, ctx) => readProfile(ctx, params.name),
});
