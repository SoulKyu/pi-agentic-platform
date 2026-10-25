import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HELPER_OPS, MODELS_LIMITS, type ModelsOverview, type ProviderView } from "@pap/contracts/pi-host";
import type { z } from "zod";
import { summaryOf } from "../../loadout.ts";
import { defineOp, type HelperOp } from "../ops.ts";
import { envSignInOf } from "./env-sign-in.ts";
import {
  enabledByPatterns,
  openRuntime,
  openSettings,
  readSignInFacts,
  type SignInFacts,
} from "./models-open.ts";

/** The most the answer may weigh: the daemon's page is 900 000 bytes and the helper's record 1 MiB. */
export const MAX_OVERVIEW_BYTES = 800_000;
const MAX_NAME = 256;
const MAX_PATTERN_ECHO = 100;
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value)) + 1;

type Provider = ReturnType<ModelRuntime["getProviders"]>[number];

function authOf(
  provider: Provider,
  origin: ProviderView["origin"],
  facts: SignInFacts,
): ProviderView["auth"] {
  const known = facts.authKnown && (origin === "builtin" || facts.modelsKnown);
  const stored = known ? (facts.stored.get(provider.id) ?? null) : null;
  const oauth = provider.auth.oauth;
  return {
    oauthLabel: oauth ? (oauth.loginLabel ?? oauth.name).slice(0, MAX_NAME) : null,
    apiKey: provider.auth.apiKey !== undefined,
    configured: known && (stored !== null || facts.keyed.has(provider.id)),
    stored,
    status: known ? "known" : "unknown",
    env: origin === "builtin" ? envSignInOf(provider.id, process.env) : [],
  };
}

export const modelsOverview: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.overview"]["params"]>,
  ModelsOverview
> = {
  params: HELPER_OPS["models.overview"].params,
  run: async (_params, ctx) => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    const builtin = new Set(builtinProviders().map((provider) => provider.id));
    const runtime = await openRuntime(ctx);
    const settings = await openSettings(ctx);
    const warnings: string[] = [];
    if (runtime.getError() !== undefined) warnings.push("Pi could not read models.json or a provider in it.");
    for (const scope of settings.unreadable) warnings.push(`Pi could not read the ${scope} settings.json.`);

    const patterns = settings.manager.getEnabledModels() ?? null;
    const scope =
      settings.trusted && settings.manager.getProjectSettings().enabledModels !== undefined
        ? "project"
        : "global";
    const enabled =
      patterns !== null && patterns.length > 0 ? await enabledByPatterns(runtime, patterns) : null;
    for (const pattern of enabled?.unmatched ?? [])
      warnings.push(`No model matches "${pattern.slice(0, MAX_PATTERN_ECHO)}".`);

    const facts = await readSignInFacts(ctx);
    if (!facts.authKnown) warnings.push("Pi's auth.json could not be read: sign-in status is unknown.");
    if (!facts.modelsKnown)
      warnings.push("models.json could not be read: its providers' sign-in status is unknown.");
    const candidates: ProviderView[] = [];
    for (const provider of runtime.getProviders()) {
      if (provider.id.length === 0 || provider.id.length > 128) continue;
      const origin = builtin.has(provider.id) ? "builtin" : "models.json";
      const auth = authOf(provider, origin, facts);
      const models = [];
      for (const model of runtime.getModels(provider.id)) {
        const summary = summaryOf(model);
        if (summary)
          models.push({
            ...summary,
            enabled: enabled === null || enabled.keys.has(`${summary.provider}/${summary.id}`),
          });
      }
      candidates.push({
        id: provider.id,
        name: provider.name.slice(0, MAX_NAME),
        origin,
        auth,
        models,
        modelsTruncated: false,
      });
    }
    // Providers the owner can use come first, so a cut never hides them behind the catalog's long tail.
    candidates.sort(
      (a, b) =>
        Number(b.auth.configured) - Number(a.auth.configured) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );

    const result: ModelsOverview = {
      providers: [],
      defaults: {
        provider: settings.manager.getDefaultProvider() ?? null,
        model: settings.manager.getDefaultModel() ?? null,
        thinkingLevel: settings.manager.getDefaultThinkingLevel() ?? null,
      },
      enabled: {
        patterns,
        scope,
        settingsPath:
          scope === "project" && settings.projectPath ? settings.projectPath : settings.globalPath,
        warnings: warnings.slice(0, MODELS_LIMITS.warnings),
      },
      offline: process.env.PI_OFFLINE !== undefined,
      truncated: false,
    };
    let bytes = size(result);
    for (const candidate of candidates) {
      const shell = { ...candidate, models: [] };
      if (result.providers.length >= MODELS_LIMITS.providers || bytes + size(shell) > MAX_OVERVIEW_BYTES) {
        result.truncated = true;
        break;
      }
      bytes += size(shell);
      const kept: ProviderView["models"] = [];
      let modelsTruncated = false;
      for (const model of candidate.models) {
        if (kept.length >= MODELS_LIMITS.models || bytes + size(model) > MAX_OVERVIEW_BYTES) {
          modelsTruncated = true;
          break;
        }
        bytes += size(model);
        kept.push(model);
      }
      result.providers.push({ ...candidate, models: kept, modelsTruncated });
    }
    return result;
  },
};
export const modelsOverviewOp = defineOp(modelsOverview);
