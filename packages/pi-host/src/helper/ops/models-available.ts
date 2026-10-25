import {
  AVAILABLE_MODELS_MAX,
  AVAILABLE_PROVIDERS_MAX,
  type AvailableModels,
  HELPER_OPS,
  type ModelSummary,
} from "@pap/contracts/pi-host";
import type { z } from "zod";
import { listAvailable } from "../../available-models.ts";
import { summaryOf } from "../../loadout.ts";
import { defineOp, HelperOpError, type HelperOp } from "../ops.ts";
import { helperErrorOf } from "./auth-store.ts";
import { openSettings, openStoreRuntime } from "./models-open.ts";

/** The most the answer may weigh: the daemon's page is 900 000 bytes and the helper's record 1 MiB. */
export const MAX_AVAILABLE_BYTES = 600_000;
const MAX_NAME = 256;
const MAX_PROVIDER_ID = 128;
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value)) + 1;

/**
 * The models a context without a session may use, by the one rule of `listAvailable` (MPR1), over pap's credential
 * store: Pi's availability check resolves no stored `!command` and calls no network (MC25, MPR2). The settings are
 * opened as the overview does (a project's patterns count only when the project is trusted).
 */
export const modelsAvailable: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.available"]["params"]>,
  AvailableModels
> = {
  params: HELPER_OPS["models.available"].params,
  run: async (_params, ctx) => {
    // Same offline restore as the worker's `freshAvailable`: the catalogs "Refresh catalog" cached (MPR25). It resolves
    // no command and calls no network. Pi's one write here: it creates models-store.json when that file is missing
    // (before it takes its lock, as the worker's refresh does); otherwise the refresh only reads it.
    const { runtime, listed } = await (async () => {
      try {
        const runtime = await openStoreRuntime(ctx);
        const settings = await openSettings(ctx);
        await runtime.refresh({ allowNetwork: false });
        return { runtime, listed: await listAvailable(runtime, settings.manager.getEnabledModels()) };
      } catch (error) {
        throw helperErrorOf(error) ?? new HelperOpError("failed", "pi configuration could not be loaded");
      }
    })();
    const names = new Map(runtime.getProviders().map((provider) => [provider.id, provider.name]));

    const result: AvailableModels = {
      models: [],
      providers: [],
      providerIds: runtime
        .getProviders()
        .map((provider) => provider.id)
        .filter((id) => id.length > 0 && id.length <= MAX_PROVIDER_ID)
        .slice(0, AVAILABLE_PROVIDERS_MAX),
      origin: listed.origin === "scope" ? "scope" : "signed-in",
      truncated: false,
    };
    let bytes = size(result);
    const seen = new Set<string>();
    for (const model of listed.models) {
      const summary: ModelSummary | null = summaryOf(model);
      if (summary === null) continue;
      const provider = seen.has(summary.provider)
        ? null
        : {
            id: summary.provider,
            name: (names.get(summary.provider) ?? summary.provider).slice(0, MAX_NAME),
          };
      const full = provider !== null && result.providers.length >= AVAILABLE_PROVIDERS_MAX;
      const cost = size(summary) + (provider === null ? 0 : size(provider));
      if (full || result.models.length >= AVAILABLE_MODELS_MAX || bytes + cost > MAX_AVAILABLE_BYTES) {
        result.truncated = true;
        break;
      }
      bytes += cost;
      result.models.push(summary);
      if (provider !== null) {
        seen.add(provider.id);
        result.providers.push(provider);
      }
    }
    return result;
  },
};
export const modelsAvailableOp = defineOp(modelsAvailable);
