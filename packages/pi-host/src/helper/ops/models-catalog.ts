import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HELPER_OPS, MODELS_LIMITS, type RefreshCatalogResult } from "@pap/contracts/pi-host";
import type { z } from "zod";
import { defineOp, HelperOpError, type HelperOp } from "../ops.ts";
import { openRuntime } from "./models-open.ts";

type Refreshable = Pick<ModelRuntime, "refresh" | "getProviders" | "getModels" | "checkAuth">;

const OFFLINE: RefreshCatalogResult = { changed: false, offline: true, failedProviders: [] };

const fingerprint = (runtime: Refreshable): string =>
  runtime
    .getProviders()
    .flatMap((provider) => runtime.getModels(provider.id).map((model) => `${provider.id}/${model.id}`))
    .sort()
    .join("\n");

/** The providers a refresh asks: dynamic ones (they have `refreshModels`) with a configured sign-in. */
async function askedProviders(runtime: Refreshable): Promise<string[]> {
  const asked: string[] = [];
  for (const provider of runtime.getProviders())
    if (provider.refreshModels && (await runtime.checkAuth(provider.id)) !== undefined)
      asked.push(provider.id);
  return asked;
}

/**
 * The one place a catalog request starts, and only on the owner's click (M7R49, decision 34). Offline (`PI_OFFLINE`)
 * answers at once with no request. Otherwise the cache is restored without the network first, so that `changed` compares
 * what the owner saw with what the provider now says. The refresh runs the owner's own `!command` keys as Pi does when it
 * calls a provider (global config; Pi reads no project's models.json). Providers that failed are named in the answer;
 * the call fails only when every provider asked failed and nothing changed.
 */
export async function refreshCatalog(runtime: Refreshable, offline: boolean): Promise<RefreshCatalogResult> {
  if (offline) return OFFLINE;
  await runtime.refresh({ allowNetwork: false });
  const before = fingerprint(runtime);
  const asked = await askedProviders(runtime);
  const result = await runtime.refresh({ allowNetwork: true, force: true });
  if (result.aborted) throw new HelperOpError("failed", "refresh aborted");
  const changed = fingerprint(runtime) !== before;
  // Per-provider errors carry provider text: only the provider ids are reported.
  const failedProviders = [...result.errors.keys()].slice(0, MODELS_LIMITS.providers);
  if (!changed && asked.length > 0 && asked.every((id) => result.errors.has(id)))
    throw new HelperOpError("failed", `${failedProviders.length} provider(s) failed to refresh`);
  return { changed, offline: false, failedProviders };
}

export const refreshCatalogOp: HelperOp<
  z.infer<(typeof HELPER_OPS)["models.refreshCatalog"]["params"]>,
  RefreshCatalogResult
> = {
  params: HELPER_OPS["models.refreshCatalog"].params,
  run: async (_params, ctx) => {
    if (process.env.PI_OFFLINE !== undefined) return OFFLINE;
    return refreshCatalog(await openRuntime(ctx), false);
  },
};
export const refreshCatalogDefinition = defineOp(refreshCatalogOp);
