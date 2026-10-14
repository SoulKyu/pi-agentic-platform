import { HELPER_OPS } from "@pap/contracts";
import { defineOp, HelperOpError } from "../ops.ts";
import {
  enabledByPatterns,
  guardSettingsWrite,
  openRuntime,
  openSettings,
  type OpenSettings,
} from "./models-open.ts";
import type { HelperContext, HelperOp } from "../ops.ts";
import type { z } from "zod";

/** Writes go through Pi's own SettingsManager (its lock, M7R48); a write that failed is read back, never assumed. */
export async function commit(settings: OpenSettings): Promise<{ ok: true }> {
  await settings.manager.flush();
  const failures = settings.manager.drainErrors();
  if (failures.length > 0) throw new HelperOpError("failed", `settings write failed (${failures[0]?.scope})`);
  return { ok: true };
}

export async function settingsToWrite(
  ctx: HelperContext,
  projectKeys: readonly string[],
): Promise<OpenSettings> {
  const settings = await openSettings(ctx);
  // A file that could not be read is never written over, and a project file that cannot be read cannot be ruled out.
  if (settings.unreadable.length > 0)
    throw new HelperOpError("config_invalid", settings.unreadable.join(","));
  if (settings.projectPath !== null) {
    const project = settings.manager.getProjectSettings() as Record<string, unknown>;
    if (projectKeys.some((key) => project[key] !== undefined))
      throw new HelperOpError("project_scope", settings.projectPath);
  }
  return settings;
}

export const setDefault: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.setDefault"]["params"]>,
  { ok: true }
> = {
  params: HELPER_OPS["models.setDefault"].params,
  run: async (params, ctx) => {
    const runtime = await openRuntime(ctx);
    if (!runtime.getModel(params.provider, params.modelId)) throw new HelperOpError("not_found", "model");
    const settings = await settingsToWrite(ctx, ["defaultProvider", "defaultModel"]);
    const patterns = settings.manager.getEnabledModels();
    if (patterns && patterns.length > 0) {
      const { keys } = await enabledByPatterns(runtime, patterns);
      if (!keys.has(`${params.provider}/${params.modelId}`)) throw new HelperOpError("bad_params", "scope");
    }
    await guardSettingsWrite(ctx);
    settings.manager.setDefaultModelAndProvider(params.provider, params.modelId);
    return commit(settings);
  },
};

export const setDefaultThinking: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.setDefaultThinking"]["params"]>,
  { ok: true }
> = {
  params: HELPER_OPS["models.setDefaultThinking"].params,
  run: async (params, ctx) => {
    const settings = await settingsToWrite(ctx, ["defaultThinkingLevel"]);
    await guardSettingsWrite(ctx);
    settings.manager.setDefaultThinkingLevel(params.level);
    return commit(settings);
  },
};

export const setDefaultOp = defineOp(setDefault);
export const setDefaultThinkingOp = defineOp(setDefaultThinking);
