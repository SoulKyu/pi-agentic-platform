import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  ModelRuntime,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAuthFileStore } from "./auth-store.ts";
import { type HelperContext, HelperOpError } from "../ops.ts";
import { parseJsonc, stripBom } from "../jsonc.ts";
import { PiFileRefused, readPiFile } from "../pi-file.ts";

/** A Pi config file must be a regular file inside the roots (M7R40b); what the refusal says is a reason, never content. */
export async function guardFile(path: string, roots: readonly string[]): Promise<void> {
  try {
    await readPiFile(path, roots);
  } catch (error) {
    if (error instanceof PiFileRefused) throw new HelperOpError("config_path_refused", error.reason);
    throw error;
  }
}

/**
 * Run immediately before Pi's SettingsManager writes `settings.json` (the one write that does not go through
 * `writePiFile`: Pi writes the file itself, in place, under its own lock). It repeats the read-time guard, so a link
 * swapped in since the file was opened is refused, and adds the write-time rule of `writePiFile`: a file with another
 * hard link is refused. What remains is the instant between this check and Pi's write (same-user race, ADR/docs).
 */
export async function guardSettingsWrite(
  ctx: Pick<HelperContext, "agentDir" | "home">,
  project?: string,
): Promise<void> {
  const files: Array<[string, string[]]> = [[join(ctx.agentDir, "settings.json"), [ctx.agentDir, ctx.home]]];
  // The project's own file too, when the call writes it (MC55): it lives inside the project folder.
  if (project !== undefined) files.push([join(project, ".pi", "settings.json"), [project]]);
  try {
    for (const [path, roots] of files) {
      const { text, real } = await readPiFile(path, roots);
      if (text !== null && (await fs.lstat(real)).nlink > 1) throw new PiFileRefused("hard-link");
    }
  } catch (error) {
    if (error instanceof PiFileRefused) throw new HelperOpError("config_path_refused", error.reason);
    throw error;
  }
}

/**
 * Pi's runtime over the agent directory's own `auth.json` and `models.json`, side-effect free (M7R46): no catalog
 * refresh, no network, no extension. Opening never runs a key that is a command: Pi's availability check reports it
 * configured without resolving it. Only discover and test resolve a key, on this runtime, on the owner's click.
 */
export async function openRuntime(ctx: Pick<HelperContext, "agentDir" | "home">): Promise<ModelRuntime> {
  const roots = [ctx.agentDir, ctx.home];
  const authPath = join(ctx.agentDir, "auth.json");
  const modelsPath = join(ctx.agentDir, "models.json");
  await guardFile(authPath, roots);
  await guardFile(modelsPath, roots);
  return ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false });
}

/** Pi's runtime over pap's credential store (MC25): availability never resolves a stored `!command`. */
export async function openStoreRuntime(ctx: Pick<HelperContext, "agentDir" | "home">): Promise<ModelRuntime> {
  const roots = [ctx.agentDir, ctx.home];
  const modelsPath = join(ctx.agentDir, "models.json");
  await guardFile(modelsPath, roots);
  return ModelRuntime.create({
    credentials: createAuthFileStore(ctx),
    modelsPath,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
}

export interface OpenSettings {
  readonly manager: SettingsManager;
  readonly trusted: boolean;
  readonly globalPath: string;
  readonly projectPath: string | null;
  /** The files that failed to load, so that nothing is written over a file that could not be read. */
  readonly unreadable: ReadonlyArray<"global" | "project">;
}

// Same rule as the worker's: only a recorded "trusted" decision counts, and a store that cannot be read means untrusted.
export const isTrusted = (agentDir: string, cwd: string): boolean => {
  try {
    return new ProjectTrustStore(agentDir).get(cwd) === true;
  } catch {
    return false;
  }
};

/** Pi's settings for the agent directory, with the project's `.pi/settings.json` only when the project is trusted. */
export async function openSettings(
  ctx: Pick<HelperContext, "agentDir" | "home" | "cwd">,
): Promise<OpenSettings> {
  const globalPath = join(ctx.agentDir, "settings.json");
  await guardFile(globalPath, [ctx.agentDir, ctx.home]);
  const trusted = ctx.cwd !== undefined && isTrusted(ctx.agentDir, ctx.cwd);
  const projectPath = trusted && ctx.cwd !== undefined ? join(ctx.cwd, ".pi", "settings.json") : null;
  if (projectPath !== null && ctx.cwd !== undefined) await guardFile(projectPath, [ctx.cwd]);
  // Without a trusted project the folder is never read; the agent directory stands in for it.
  const manager = SettingsManager.create(trusted && ctx.cwd ? ctx.cwd : ctx.agentDir, ctx.agentDir, {
    projectTrusted: trusted,
  });
  const unreadable = manager.drainErrors().map((entry) => entry.scope);
  return { manager, trusted, globalPath, projectPath, unreadable };
}

/**
 * The `provider/id` of every model the patterns enable, among ALL the runtime's models (not only those with a key:
 * the owner enables a model before signing in). Pi's own matcher does the work; it reads the available list, so it is
 * handed the full one.
 */
export async function enabledByPatterns(
  runtime: ModelRuntime,
  patterns: readonly string[],
): Promise<{
  keys: ReadonlySet<string>;
  /** The same models as objects, for a caller that keys them its own way. */
  models: ReadonlyArray<{ readonly provider: string; readonly id: string }>;
  unmatched: string[];
}> {
  const everything = runtime.getModels();
  const view = { getAvailable: async () => everything } as unknown as ModelRuntime;
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics([...patterns], view);
  return {
    keys: new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`)),
    models: scopedModels.map(({ model }) => model),
    unmatched: diagnostics.filter((entry) => entry.code === "no-match").map((entry) => entry.pattern),
  };
}

type JsonRead = { kind: "missing" } | { kind: "unknown" } | { kind: "ok"; value: Record<string, unknown> };

/** pap's own bounded read of a Pi JSON file (Pi's own tolerance per file: auth.json BOM only, models.json BOM, `//` comments, trailing commas): never a Pi call, never a command. */
async function readJsonObject(
  path: string,
  roots: readonly string[],
  parse: (text: string) => unknown,
): Promise<JsonRead> {
  const { text } = await readPiFile(path, roots);
  if (text === null) return { kind: "missing" };
  try {
    const value = parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return { kind: "ok", value: value as Record<string, unknown> };
  } catch {
    // an unparseable file is "unknown", below
  }
  return { kind: "unknown" };
}

export interface SignInFacts {
  /** False when auth.json could not be read: no provider's stored state is known. */
  readonly authKnown: boolean;
  /** False when models.json could not be read: its own providers' state is not known. */
  readonly modelsKnown: boolean;
  readonly stored: ReadonlyMap<string, "oauth" | "api_key">;
  /** models.json providers that carry a key (a literal or a command; the value is never read further). */
  readonly keyed: ReadonlySet<string>;
}

/**
 * What the overview says about sign-in, from the two files only (MC25). Pi's `checkAuth` RUNS a `!command` stored in
 * auth.json and is never called, nor is `listCredentials`. Sign-in through an environment variable is not seen here.
 */
export async function readSignInFacts(ctx: HelperContext): Promise<SignInFacts> {
  const roots = [ctx.agentDir, ctx.home];
  const auth = await readJsonObject(join(ctx.agentDir, "auth.json"), roots, (text) =>
    JSON.parse(stripBom(text)),
  );
  const models = await readJsonObject(join(ctx.agentDir, "models.json"), roots, parseJsonc);
  const stored = new Map<string, "oauth" | "api_key">();
  if (auth.kind === "ok")
    for (const [id, credential] of Object.entries(auth.value)) {
      const type = (credential as { type?: unknown } | null)?.type;
      if (type === "oauth" || type === "api_key") stored.set(id, type);
    }
  const keyed = new Set<string>();
  const providers =
    models.kind === "ok" ? (models.value.providers as Record<string, unknown> | undefined) : undefined;
  if (typeof providers === "object" && providers !== null)
    for (const [id, config] of Object.entries(providers)) {
      const key = (config as { apiKey?: unknown } | null)?.apiKey;
      if (typeof key === "string" && key !== "") keyed.add(id);
    }
  return { authKnown: auth.kind !== "unknown", modelsKnown: models.kind !== "unknown", stored, keyed };
}
