import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  HELPER_OPS,
  TRUST_LIMITS,
  type TrustResources,
  type TrustSetHelperResult,
  type TrustStatus,
} from "@pap/contracts";
import type { z } from "zod";
import { logLineOf } from "../../bounded.ts";
import { within } from "../../policy/target-path.ts";
import { stripBom } from "../jsonc.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import { readPiFile } from "../pi-file.ts";
import { trustRefusal } from "../trust-breadth.ts";
import { readMcpFiles } from "./mcp-read.ts";
import { offline } from "./offline.ts";

type Ctx = Pick<HelperContext, "agentDir" | "papHome" | "home" | "cwd">;
type Params<N extends keyof typeof HELPER_OPS> = z.infer<(typeof HELPER_OPS)[N]["params"]>;

/** A directory is read this far: a folder with a million entries lists its first thousand, sorted, and says so. */
const SCAN_ENTRIES_MAX = 1000;

const stderrLog = (message: string): void => void process.stderr.write(`pi-helper: ${message}\n`);

/** The folder's real path (M7R103): a link is judged by where it leads, and anything but a folder is `bad_params`. */
async function realFolder(cwd: string | undefined): Promise<string> {
  if (cwd === undefined) throw new HelperOpError("bad_params", "cwd");
  try {
    const real = await fs.realpath(cwd);
    if (!(await fs.stat(real)).isDirectory()) throw new Error("not a folder");
    return real;
  } catch {
    throw new HelperOpError("bad_params", "cwd");
  }
}

const realOr = async (path: string): Promise<string> => fs.realpath(path).catch(() => resolve(path));

/** A file name is untrusted text: control, bidi and zero-width characters go, the rest is clipped to the contract's bound. */
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
function cleanName(raw: string): string {
  return raw
    .replace(CONTROL, "")
    .slice(0, TRUST_LIMITS.name)
    .replace(/[\ud800-\udbff]$/, "");
}

interface Names {
  readonly names: string[];
  readonly truncated: boolean;
}

/** What was not listed, as fixed strings (never file content): a project-relative path and a reason. */
type Notes = string[];
const note = (notes: Notes, label: string, reason: string): void => void notes.push(`${label}: ${reason}`);

/**
 * The entries of `dir`, only when its real path lies inside `base` (M7R84). A folder that is a link out, cannot be read,
 * or holds more than the scan reads is said so in `notes`, never silently dropped: Pi may load it once trusted.
 */
async function entriesOf(
  dir: string,
  base: string,
  label: string,
  notes: Notes,
): Promise<{ name: string; kind: "file" | "dir" | "link" }[]> {
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") note(notes, label, "cannot be read");
    return [];
  }
  if (!within(base, real)) {
    note(notes, label, "link leaving the folder, not listed");
    return [];
  }
  const found: { name: string; kind: "file" | "dir" | "link" }[] = [];
  try {
    const handle = await fs.opendir(real);
    try {
      for await (const entry of handle) {
        if (found.length >= SCAN_ENTRIES_MAX) {
          note(notes, label, "more entries than are read");
          break;
        }
        found.push({
          name: entry.name,
          kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file",
        });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    note(notes, label, "cannot be read");
    return [];
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const EXTENSION_FILE = /\.(?:ts|js|mjs|cjs)$/;

function limited(all: readonly string[], max: number): Names {
  const unique = [...new Set(all.map(cleanName).filter((name) => name !== ""))];
  return { names: unique.slice(0, max), truncated: unique.length > max };
}

async function extensionsOf(cwd: string, notes: Notes): Promise<Names> {
  const entries = await entriesOf(join(cwd, ".pi", "extensions"), cwd, ".pi/extensions", notes);
  return limited(
    entries
      .filter(
        (entry) => !entry.name.startsWith(".") && (entry.kind !== "file" || EXTENSION_FILE.test(entry.name)),
      )
      .map((entry) => entry.name),
    TRUST_LIMITS.extensions,
  );
}

/** Pi reads `.pi/skills` and the `.agents/skills` of the folder and of every folder above it, except the user's own. */
async function skillsOf(cwd: string, home: string, notes: Notes): Promise<Names> {
  const userSkills = join(home, ".agents", "skills");
  const found: string[] = [];
  const scan = async (dir: string, base: string, label: string, rootMarkdown: boolean): Promise<void> => {
    for (const entry of await entriesOf(dir, base, label, notes)) {
      if (entry.name.startsWith(".")) continue;
      if (entry.kind !== "file" || (rootMarkdown && entry.name.endsWith(".md"))) found.push(entry.name);
    }
  };
  await scan(join(cwd, ".pi", "skills"), cwd, ".pi/skills", true);
  for (let dir = cwd; ; dir = dirname(dir)) {
    const skills = join(dir, ".agents", "skills");
    if (skills !== userSkills)
      await scan(skills, dir, dir === cwd ? ".agents/skills" : ".agents/skills of a folder above", false);
    if (dirname(dir) === dir) break;
  }
  return limited(found, TRUST_LIMITS.skills);
}

async function promptTemplatesOf(cwd: string, notes: Notes): Promise<number> {
  const entries = await entriesOf(join(cwd, ".pi", "prompts"), cwd, ".pi/prompts", notes);
  return entries.filter((entry) => entry.kind !== "dir" && entry.name.endsWith(".md")).length;
}

/** The top-level keys of `.pi/settings.json` and nothing else: never a value (M7R107). */
async function settingsKeysOf(cwd: string, notes: Notes): Promise<Names> {
  const none: Names = { names: [], truncated: false };
  const label = ".pi/settings.json";
  let parsed: unknown;
  try {
    const { text } = await readPiFile(join(cwd, ".pi", "settings.json"), [cwd]);
    if (text === null) return none;
    parsed = JSON.parse(stripBom(text));
  } catch {
    note(notes, label, "cannot be read or is not JSON");
    return none;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    note(notes, label, "is not an object");
    return none;
  }
  return limited(Object.keys(parsed), TRUST_LIMITS.settingsKeys);
}

const exists = (path: string): Promise<boolean> =>
  fs.lstat(path).then(
    () => true,
    () => false,
  );

async function resourcesOf(ctx: Ctx, cwd: string): Promise<TrustResources> {
  const notes: Notes = [];
  const [servers, extensions, skills, promptTemplates, settingsKeys, system, appended] = await Promise.all([
    readMcpFiles({ agentDir: ctx.agentDir, home: ctx.home, cwd }),
    extensionsOf(cwd, notes),
    skillsOf(cwd, ctx.home, notes),
    promptTemplatesOf(cwd, notes),
    settingsKeysOf(cwd, notes),
    exists(join(cwd, ".pi", "SYSTEM.md")),
    exists(join(cwd, ".pi", "APPEND_SYSTEM.md")),
  ]);
  // Pi reads a file pap's reader refuses (too many servers, too large, a link out): say so, the list would look empty.
  if (servers.project?.problem) note(notes, ".pi/mcp.json", `not listed (${servers.project.problem})`);
  return {
    mcpServers: servers.project?.servers ?? [],
    extensions: extensions.names,
    skills: skills.names,
    promptTemplates,
    settingsKeys: settingsKeys.names,
    systemPrompt: system || appended,
    truncated:
      extensions.truncated ||
      skills.truncated ||
      settingsKeys.truncated ||
      notes.some((entry) => entry.endsWith("more entries than are read")),
    unlisted: [...new Set(notes)].sort().slice(0, TRUST_LIMITS.unlisted),
  };
}

/**
 * What Pi's store says about the folder and what trusting it would turn on (M7R103, M7R107). A store that cannot be read
 * makes the decision `null` (untrusted, like the worker's resolver) and is logged once with its own message.
 */
export const trustStatus = (ctx: Ctx, log: (message: string) => void = stderrLog): Promise<TrustStatus> =>
  offline(() => readTrustStatus(ctx, log));

async function readTrustStatus(ctx: Ctx, log: (message: string) => void): Promise<TrustStatus> {
  const folder = await realFolder(ctx.cwd);
  let entry: { path: string; decision: boolean } | null = null;
  try {
    entry = new ProjectTrustStore(ctx.agentDir).getEntry(folder);
  } catch (error) {
    log(`trust store unreadable: ${logLineOf(error).slice(0, 200)}`);
  }
  let requiresTrust = true;
  try {
    requiresTrust = hasTrustRequiringProjectResources(folder);
  } catch {
    // an unreadable folder is asked about rather than waved through
  }
  return {
    requiresTrust,
    decision: entry?.decision ?? null,
    decisionPath: entry?.path ?? null,
    inherited: entry !== null && entry.path !== folder,
    resources: await resourcesOf(ctx, folder),
  };
}

/**
 * Records, or clears, the decision for the folder's real path through Pi's own store (M7R103). Trusting is refused for a
 * folder that would trust too much (M7R104); `false` and clearing only narrow, so they have no such rule. A store that
 * cannot be read or written fails the call (`failed`), never a decision made on a guess.
 */
export async function trustSet(params: Params<"trust.set">, ctx: Ctx): Promise<TrustSetHelperResult> {
  const folder = await realFolder(ctx.cwd);
  if (params.decision === true) {
    const refusal = trustRefusal(folder, {
      home: await realOr(ctx.home),
      agentDir: await realOr(ctx.agentDir),
      papHome: await realOr(ctx.papHome),
      projects: await Promise.all(params.projects.map(realOr)),
    });
    if (refusal !== null) return { ok: false, refusal };
  }
  try {
    new ProjectTrustStore(ctx.agentDir).set(folder, params.decision);
  } catch (error) {
    throw new HelperOpError("failed", `trust store: ${logLineOf(error).slice(0, 160)}`);
  }
  return { ok: true, folder };
}

export const trustStatusOp = defineOp({
  params: HELPER_OPS["trust.status"].params,
  run: (_params, ctx) => trustStatus(ctx),
});
export const trustSetOp = defineOp({
  params: HELPER_OPS["trust.set"].params,
  run: (params, ctx) => trustSet(params, ctx),
});
