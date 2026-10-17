import {
  EXTENSION_MODELS_MAX,
  EXTENSION_PROVIDERS_MAX,
  type ExtensionProviders,
  HELPER_OPS,
  type ModelSummary,
} from "@pap/contracts";
import type { z } from "zod";
import { summaryOf } from "../../loadout.ts";
import { defineOp, type HelperContext, type HelperOp } from "../ops.ts";
import { type ExtensionLoad, loadRuntime, openExtensionLoad } from "./extension-load.ts";

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

/** The part of Pi's runtime this operation reads: the tests hand in a stand-in for the slow cases. */
export interface ExtensionsLoad extends Pick<ExtensionLoad, "extensionsFailed"> {
  readonly runtime: Pick<ExtensionLoad["runtime"], "getRegisteredProviderIds" | "getProvider" | "getModels">;
}

/**
 * The providers the owner's global extensions register, on their click (MPR17, MC52): Pi's configuration is loaded the
 * way `models.usage` loads it (offline, no project, nothing trusted), so an extension of a project is never run. A load
 * or registration error answers `failed` with no provider: nothing is guessed. The built-in providers and the ones of
 * `models.json` are not listed (the pickers have them), and neither a base URL, a header nor a key is read.
 */
export const createExtensionsOp = (
  open: (ctx: HelperContext) => Promise<ExtensionsLoad> = openExtensionLoad,
): HelperOp<z.infer<(typeof HELPER_OPS)["models.extensions"]["params"]>, ExtensionProviders> => ({
  params: HELPER_OPS["models.extensions"].params,
  run: async (_params, ctx) => {
    const { runtime, extensionsFailed } = await loadRuntime(open, ctx);
    if (extensionsFailed) return FAILED;
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
        models: [] as ModelSummary[],
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
        const cost = size(summary);
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
        entry.models.push(summary);
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
