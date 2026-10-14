import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  HELPER_OPS,
  MODELS_CONFIG_ISSUE_MAX_LENGTH,
  MODELS_CONFIG_ISSUES_MAX,
  MODELS_CONFIG_TEXT_MAX,
  MODELS_LIMITS,
  type ConfigSaveResult,
} from "@pap/contracts";
import { z } from "zod";
import { JsoncError, parseJsonc } from "../jsonc.ts";
import { maskModelsJson, unmaskModelsJson } from "../models-json-mask.ts";
import { PiFileRefused, readPiFile, writePiFile } from "../pi-file.ts";
import { defineOp, type HelperContext, HelperOpError, type HelperOp } from "../ops.ts";
import { planEnabledEdit, same } from "./enabled-models.ts";
import { commit, settingsToWrite } from "./models-defaults.ts";
import { brokenIssues, lineColumn } from "./models-json-issues.ts";
import { enabledByPatterns, guardSettingsWrite, openRuntime, openSettings } from "./models-open.ts";

/** The revision (MC32): an HMAC under the daemon's boot key, so it is no hash anyone can test a guessed secret against. */
const revisionOf = (key: string, text: string | null): string =>
  createHmac("sha256", key)
    .update(text ?? "")
    .digest("hex");
const INVALID_ROOT = ["$"];

/** The file is always the agent directory's own `models.json` (M7R63); a link may lead anywhere inside the agent directory or the home. */
const location = (ctx: HelperContext) => ({
  path: join(ctx.agentDir, "models.json"),
  roots: [ctx.agentDir, ctx.home],
});

/** What a refusal of the Pi file boundary says: a fixed code, never a path or an errno text. */
function refused(error: unknown): never {
  if (error instanceof PiFileRefused)
    throw new HelperOpError(
      error.reason === "hard-link" ? "config_hard_link" : "config_path_refused",
      error.reason,
    );
  throw error;
}

async function readCurrent(ctx: HelperContext): Promise<string | null> {
  const { path, roots } = location(ctx);
  try {
    return (await readPiFile(path, roots)).text;
  } catch (error) {
    return refused(error);
  }
}

function maskOrRefuse(text: string) {
  try {
    return maskModelsJson(text);
  } catch {
    throw new HelperOpError("config_invalid", "models.json cannot be masked");
  }
}

/** What a save can put back: the secrets of the file as it is, none when it does not parse (a broken file is shown to nobody, so no placeholder can come from it). */
function priorSecrets(current: string | null) {
  if (current === null || brokenIssues(current) !== null) return { secrets: [], places: [] };
  return maskOrRefuse(current);
}

export const configGet: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.config.get"]["params"]>,
  z.infer<(typeof HELPER_OPS)["models.config.get"]["result"]>
> = {
  params: HELPER_OPS["models.config.get"].params,
  run: async (params, ctx) => {
    const { path } = location(ctx);
    const current = await readCurrent(ctx);
    const revision = revisionOf(params.revisionKey, current);
    if (current === null) return { text: null, issues: [], revision, path };
    // Fail closed: a file that does not parse is not shown at all, since masking cannot be trusted on it (MC32).
    const broken = brokenIssues(current);
    if (broken !== null) return { text: null, issues: broken, revision, path };
    const { masked } = maskOrRefuse(current);
    // The record that carries the text is JSON: quotes and newlines count twice.
    if (
      masked.length > MODELS_CONFIG_TEXT_MAX ||
      Buffer.byteLength(JSON.stringify(masked)) > MODELS_CONFIG_TEXT_MAX
    )
      throw new HelperOpError("config_path_refused", "too-large");
    return { text: masked, issues: [], revision, path };
  },
};

// ---- validation (M7R64): Pi's own tolerance, a lenient shape, then Pi's own loader ----

const Text = z.string();
const Provider = z
  .object({
    name: Text.optional(),
    baseUrl: Text.optional(),
    apiKey: Text.optional(),
    api: Text.optional(),
    authHeader: z.boolean().optional(),
    headers: z.record(Text, Text).optional(),
    models: z.array(z.object({ id: Text.min(1) }).loose()).optional(),
  })
  .loose();
const Shape = z.object({ providers: z.record(Text, Provider).optional() }).loose();

/** A JSON path from a zod path: keys are clipped and reduced to plain characters, since a key is file text. */
function pathOf(path: ReadonlyArray<PropertyKey>): string {
  const parts = path.map((part) =>
    typeof part === "number"
      ? `[${part}]`
      : `.${String(part)
          .replace(/[^\w-]/g, "*")
          .slice(0, 32)}`,
  );
  return `$${parts.join("")}`.replace(/\.\[/g, "[").slice(0, MODELS_CONFIG_ISSUE_MAX_LENGTH);
}

/**
 * Loads the candidate text (real secrets restored) with Pi's own loader from a private copy, side-effect free (no
 * network, no catalog, no command). The copy lives in a 0700 folder under the pap home, is removed afterwards, and
 * a leftover is swept at daemon boot (MC32 m3).
 */
async function piRejects(text: string, ctx: HelperContext): Promise<boolean> {
  const folder = join(ctx.papHome, "models-check");
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.chmod(folder, 0o700);
  const dir = await fs.mkdtemp(join(folder, "check-"));
  try {
    const modelsPath = join(dir, "models.json");
    await fs.writeFile(modelsPath, text, { mode: 0o600 });
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath,
      modelsStorePath: join(dir, "models-cache.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    return runtime.getError() !== undefined;
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      ctx.emit({ kind: "validation_copy_not_removed", code: "failed" });
    }
  }
}

/** JSON paths and positions only: a parser's or Pi's message can quote a secret, so none is ever returned. */
async function issuesOf(text: string, ctx: HelperContext): Promise<string[]> {
  const broken = brokenIssues(text);
  if (broken !== null) return broken;
  const shape = Shape.safeParse(parseJsonc(text));
  if (!shape.success) return [...new Set(shape.error.issues.map((issue) => pathOf(issue.path)))];
  return (await piRejects(text, ctx)) ? INVALID_ROOT : [];
}

const invalid = (issues: readonly string[]): ConfigSaveResult => ({
  code: "config_invalid",
  issues: [...new Set(issues)].slice(0, MODELS_CONFIG_ISSUES_MAX),
});

// ---- enabledModels follows the file (M7R65) ----

const providersOf = (text: string | null): string[] => {
  try {
    const value = text === null ? undefined : (parseJsonc(text) as { providers?: unknown } | null)?.providers;
    return typeof value === "object" && value !== null ? Object.keys(value) : [];
  } catch {
    return [];
  }
};

/**
 * The providers of this file (before or after the edit) whose models are all enabled right now: what `resync`
 * re-asserts once the file has changed. Computed from the same matching the overview shows its `enabled` flags with.
 */
async function fullyEnabled(ctx: HelperContext, named: ReadonlySet<string>): Promise<string[]> {
  const settings = await openSettings(ctx);
  const patterns = settings.manager.getEnabledModels();
  if (!patterns || patterns.length === 0) return [];
  const runtime = await openRuntime(ctx);
  const { keys } = await enabledByPatterns(runtime, patterns);
  return runtime
    .getProviders()
    .map((provider) => provider.id)
    .filter((id) => named.has(id))
    .filter((id) => {
      const models = runtime.getModels(id);
      return models.length > 0 && models.every((model) => keys.has(`${id}/${model.id}`));
    })
    .slice(0, MODELS_LIMITS.providers);
}

/** The file is already saved: whatever goes wrong here is reported as "not synced" with a code, never as a failed save. */
async function resync(ctx: HelperContext, providers: readonly string[]): Promise<boolean> {
  if (providers.length === 0) return true;
  try {
    const runtime = await openRuntime(ctx);
    const settings = await settingsToWrite(ctx, ["enabledModels"]);
    const current: unknown = settings.manager.getEnabledModels();
    if (current === undefined) return true;
    if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) return false;
    const models = runtime.getModels().map(({ provider, id, name }) => ({ provider, id, name }));
    const plan = await planEnabledEdit(
      current as string[],
      { op: "resync", providers: [...providers] },
      { models },
    );
    if ("refused" in plan) return false;
    if (same(plan.patterns, current as string[])) return true;
    await guardSettingsWrite(ctx);
    settings.manager.setEnabledModels(plan.patterns);
    await commit(settings);
    return true;
  } catch (error) {
    ctx.emit({
      kind: "enabled_models_not_synced",
      code: error instanceof HelperOpError ? error.code : "failed",
    });
    return false;
  }
}

export const configSave: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.config.save"]["params"]>,
  ConfigSaveResult
> = {
  params: HELPER_OPS["models.config.save"].params,
  run: async (params, ctx) => {
    const { path, roots } = location(ctx);
    const current = await readCurrent(ctx);
    if (revisionOf(params.revisionKey, current) !== params.baseRevision)
      throw new HelperOpError("conflict", "revision");
    // Positions are those of the text the client sent, secrets still masked: restoring them first would shift the
    // columns after a secret by its length and so tell how long it is.
    const submitted = brokenIssues(params.text);
    if (submitted !== null) return invalid(submitted);
    const prior = priorSecrets(current);
    let restored: string | { refused: number };
    try {
      restored = unmaskModelsJson(params.text, prior.secrets, prior.places, MODELS_CONFIG_TEXT_MAX);
    } catch (error) {
      if (error instanceof JsoncError) return invalid([error.message]);
      if (error instanceof RangeError) return invalid(["text too large"]);
      throw error;
    }
    if (typeof restored !== "string") {
      const { line, column } = lineColumn(params.text, restored.refused);
      return invalid([`masked_value_moved at line ${line}, column ${column}`]);
    }
    if (Buffer.byteLength(restored) > MODELS_CONFIG_TEXT_MAX) return invalid(["text too large"]);
    const issues = await issuesOf(restored, ctx);
    if (issues.length > 0) return invalid(issues);

    const named = new Set([...providersOf(current), ...providersOf(restored)]);
    // null: the settings could not be read, so what was enabled is unknown and nothing can be re-asserted.
    const before = await fullyEnabled(ctx, named).catch(() => null);
    // The file may have moved while it was validated: check again immediately before the write.
    if (revisionOf(params.revisionKey, await readCurrent(ctx)) !== params.baseRevision)
      throw new HelperOpError("conflict", "revision");
    try {
      await writePiFile(path, restored, {
        roots,
        mode: 0o600,
        keepMode: false,
        onFolderSyncFailed: (code) =>
          ctx.emit({ kind: "folder_sync_failed", code: /^[A-Z0-9_]{1,16}$/.test(code) ? code : "UNKNOWN" }),
      });
    } catch (error) {
      return refused(error);
    }
    if (before === null) ctx.emit({ kind: "enabled_models_not_synced", code: "unreadable" });
    return {
      revision: revisionOf(params.revisionKey, restored),
      enabledModelsSynced: before !== null && (await resync(ctx, before)),
    };
  },
};

export const configGetOp = defineOp(configGet);
export const configSaveOp = defineOp(configSave);
