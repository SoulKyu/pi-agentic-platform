import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type ConfigSaveResult,
  MODELS_CONFIG_ISSUES_MAX,
  MODELS_CONFIG_TEXT_MAX,
  MODELS_LIMITS,
} from "@pap/contracts";
import { parseJsonc } from "../jsonc.ts";
import { maskModelsJson } from "../models-json-mask.ts";
import { PiFileRefused, readPiFile, writePiFile } from "../pi-file.ts";
import { type HelperContext, HelperOpError } from "../ops.ts";
import { planEnabledEdit, same } from "./enabled-models.ts";
import { commit, settingsToWrite } from "./models-defaults.ts";
import { enabledByPatterns, guardSettingsWrite, openRuntime, openSettings } from "./models-open.ts";

// Shared by models.config.* and models.provider.*: moved out of models-json.ts unchanged (MPR-C1).
/** The revision (MC32): an HMAC under the daemon's boot key, so it is no hash anyone can test a guessed secret against. */
export const revisionOf = (key: string, text: string | null): string =>
  createHmac("sha256", key)
    .update(text ?? "")
    .digest("hex");
export const INVALID_ROOT = ["$"];

/** The file is always the agent directory's own `models.json` (M7R63); a link may lead anywhere inside the agent directory or the home. */
export const location = (ctx: HelperContext) => ({
  path: join(ctx.agentDir, "models.json"),
  roots: [ctx.agentDir, ctx.home],
});

/** What a refusal of the Pi file boundary says: a fixed code, never a path or an errno text. */
export function refused(error: unknown): never {
  if (error instanceof PiFileRefused)
    throw new HelperOpError(
      error.reason === "hard-link" ? "config_hard_link" : "config_path_refused",
      error.reason,
    );
  throw error;
}

export async function readCurrent(ctx: HelperContext): Promise<string | null> {
  const { path, roots } = location(ctx);
  try {
    return (await readPiFile(path, roots)).text;
  } catch (error) {
    return refused(error);
  }
}

/**
 * Loads the candidate text (real secrets restored) with Pi's own loader from a private copy, side-effect free (no
 * network, no catalog, no command). The copy lives in a 0700 folder under the pap home, is removed afterwards, and
 * a leftover is swept at daemon boot (MC32 m3).
 */
export async function piRejects(text: string, ctx: HelperContext): Promise<boolean> {
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

/** Masks `text` as the editor would show it; a text that cannot be masked is refused, since nothing can be shown of it safely. */
export function maskOrRefuse(text: string) {
  try {
    return maskModelsJson(text);
  } catch {
    throw new HelperOpError("config_invalid", "models.json cannot be masked");
  }
}

/**
 * THE size test of the editor's text (configGet, provider save, provider remove): `masked` is the masked text, and it
 * must fit both in characters and once carried as a JSON string, where quotes and newlines count twice. A rewrite
 * pretty-prints, so a remove can make the file larger than the one it read.
 */
export const tooLarge = (masked: string): boolean =>
  masked.length > MODELS_CONFIG_TEXT_MAX ||
  Buffer.byteLength(JSON.stringify(masked)) > MODELS_CONFIG_TEXT_MAX;

export const invalid = (issues: readonly string[]): ConfigSaveResult => ({
  code: "config_invalid",
  issues: [...new Set(issues)].slice(0, MODELS_CONFIG_ISSUES_MAX),
});

export const providersOf = (text: string | null): string[] => {
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
export async function fullyEnabled(ctx: HelperContext, named: ReadonlySet<string>): Promise<string[]> {
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
export async function resync(ctx: HelperContext, providers: readonly string[]): Promise<boolean> {
  if (providers.length === 0) return true;
  try {
    const runtime = await openRuntime(ctx);
    const settings = await settingsToWrite(ctx, ["enabledModels"]);
    const current: unknown = settings.manager.getEnabledModels();
    if (current === undefined) return true;
    if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) return false;
    const models = runtime.getModels().map(({ provider, id, name }) => ({ provider, id, name }));
    // Without extensions loaded (a models.json save never loads them): what this view cannot judge stays as it was.
    const known = runtime.getProviders().map((provider) => provider.id);
    const plan = await planEnabledEdit(
      current as string[],
      { op: "resync", providers: [...providers] },
      { models, providers: known, complete: false },
    );
    if (!("patterns" in plan)) return false;
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

/**
 * The write tail of every models.json edit: the providers that were fully enabled are noted, the revision is checked
 * again right before the write (the file may have moved while the candidate was validated), the write is atomic and
 * 0600, and `enabledModels` follows. `baseRevision` is the one the caller READ, never a fresh one.
 */
export async function commitText(
  ctx: HelperContext,
  revisionKey: string,
  baseRevision: string,
  current: string | null,
  text: string,
): Promise<ConfigSaveResult> {
  const { path, roots } = location(ctx);
  const named = new Set([...providersOf(current), ...providersOf(text)]);
  // null: the settings could not be read, so what was enabled is unknown and nothing can be re-asserted.
  const before = await fullyEnabled(ctx, named).catch(() => null);
  if (revisionOf(revisionKey, await readCurrent(ctx)) !== baseRevision)
    throw new HelperOpError("conflict", "revision");
  try {
    await writePiFile(path, text, {
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
    revision: revisionOf(revisionKey, text),
    enabledModelsSynced: before !== null && (await resync(ctx, before)),
  };
}
