import {
  EXTENSION_MODELS_MAX,
  EXTENSION_PROVIDERS_MAX,
  type ExtensionModel,
  type ExtensionProviders,
  HELPER_OPS,
} from "@pap/contracts";
import type { z } from "zod";
import { listAvailable } from "../../available-models.ts";
import { summaryOf } from "../../loadout.ts";
import { defineOp, type HelperContext, type HelperOp } from "../ops.ts";
import { type ExtensionLoad, loadRuntime, openExtensionLoad } from "./extension-load.ts";
import { enabledByPatterns } from "./models-open.ts";

/** The helper's record is 1 MiB: the answer stays well under it, as `models.available` does. */
export const MAX_EXTENSIONS_BYTES = 600_000;
const MAX_NAME = 256;
const MAX_PROVIDER_ID = 128;
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value)) + 1;

const FAILED: ExtensionProviders = { providers: [], truncated: false, failed: true };

async function builtinIds(): Promise<ReadonlySet<string>> {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  return new Set(builtinProviders().map((provider) => provider.id));
}

/** What the global selection says of the models of a load, as `provider/id` keys (separator-safe). */
export interface SelectionFacts {
  /** The no-session rule offers them. */
  readonly offered: ReadonlySet<string>;
  /** The selection names them (what Settings' switches show); null: there is no selection, every model is on. */
  readonly enabled: ReadonlySet<string> | null;
}

/** The part of Pi's runtime this operation reads: the tests hand in a stand-in for the slow cases. */
export interface ExtensionsLoad extends Pick<ExtensionLoad, "extensionsFailed"> {
  readonly runtime: Pick<ExtensionLoad["runtime"], "getRegisteredProviderIds" | "getProvider" | "getModels">;
  selection(): Promise<SelectionFacts>;
}

const keyOf = (model: { provider: string; id: string }): string => JSON.stringify([model.provider, model.id]);

/**
 * Pi's load with the one rule of `listAvailable` over it (ADR 0068): the global selection, the providers with a key,
 * after the same offline refresh as `models.available` and a worker. An agent's worker loads the same global
 * extensions and settings, so a model offered here is one its `set_model` accepts. `enabled` is the overview's own
 * rule (`enabledByPatterns`, among every model), so an extension's switch reads like any other.
 */
async function openExtensions(ctx: HelperContext): Promise<ExtensionsLoad> {
  const load = await openExtensionLoad(ctx);
  return {
    ...load,
    selection: async () => {
      await load.runtime.refresh({ allowNetwork: false });
      const patterns = load.settings.getEnabledModels();
      const listed = await listAvailable(load.runtime, patterns);
      const named =
        patterns !== undefined && patterns.length > 0
          ? await enabledByPatterns(load.runtime, patterns)
          : null;
      return {
        offered: new Set(listed.models.map(keyOf)),
        enabled: named === null ? null : new Set(named.models.map(keyOf)),
      };
    },
  };
}

/**
 * The providers the owner's global extensions register, on their click (MPR17, MC52): Pi's configuration is loaded the
 * way `models.usage` loads it (offline, no project, nothing trusted), so an extension of a project is never run. A load
 * or registration error answers `failed` with no provider: nothing is guessed. The built-in providers and the ones of
 * `models.json` are not listed (the pickers have them), and neither a base URL, a header nor a key is read. Each model
 * says whether the no-session rule offers it (`offered`), which is what the pickers list.
 */
export const createExtensionsOp = (
  open: (ctx: HelperContext) => Promise<ExtensionsLoad> = openExtensions,
): HelperOp<z.infer<(typeof HELPER_OPS)["models.extensions"]["params"]>, ExtensionProviders> => ({
  params: HELPER_OPS["models.extensions"].params,
  run: async (_params, ctx) => {
    const { runtime, extensionsFailed, selection: readSelection } = await loadRuntime(open, ctx);
    if (extensionsFailed) return FAILED;
    const { offered, enabled } = await loadRuntime(() => readSelection(), ctx);
    const builtin = await builtinIds();
    const result: ExtensionProviders = { providers: [], truncated: false, failed: false };
    let bytes = size(result);
    for (const id of runtime.getRegisteredProviderIds()) {
      if (builtin.has(id)) continue;
      // An id that does not fit the contract is left out, never clipped (a clipped id would name another provider).
      if (id.length === 0 || id.length > MAX_PROVIDER_ID) {
        result.truncated = true;
        continue;
      }
      // The first limit that stops the list ends it: no later provider is listed, so no empty row follows a cut.
      if (result.providers.length >= EXTENSION_PROVIDERS_MAX) {
        result.truncated = true;
        break;
      }
      const entry = {
        id,
        name: (runtime.getProvider(id)?.name ?? id).slice(0, MAX_NAME),
        models: [] as ExtensionModel[],
        modelsTruncated: false,
      };
      if (bytes + size(entry) > MAX_EXTENSIONS_BYTES) {
        result.truncated = true;
        break;
      }
      bytes += size(entry);
      let full = false;
      for (const model of runtime.getModels(id)) {
        const summary = summaryOf(model);
        if (summary === null) {
          entry.modelsTruncated = true; // an id over 256 characters (or an empty one) cannot be listed: say so
          continue;
        }
        const key = keyOf(summary);
        const row: ExtensionModel = {
          ...summary,
          offered: offered.has(key),
          enabled: enabled === null || enabled.has(key),
        };
        const cost = size(row);
        if (entry.models.length >= EXTENSION_MODELS_MAX) {
          entry.modelsTruncated = true;
          break;
        }
        if (bytes + cost > MAX_EXTENSIONS_BYTES) {
          entry.modelsTruncated = true;
          full = true;
          break;
        }
        bytes += cost;
        entry.models.push(row);
      }
      // Even its first model did not fit: the provider is dropped rather than shown with nothing.
      if (!(full && entry.models.length === 0)) result.providers.push(entry);
      if (full) {
        result.truncated = true;
        break;
      }
    }
    return result;
  },
});
export const modelsExtensions = createExtensionsOp();
export const modelsExtensionsOp = defineOp(modelsExtensions);
