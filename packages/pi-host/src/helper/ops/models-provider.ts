import { HELPER_OPS, type ConfigSaveResult } from "@pap/contracts/pi-host";
import type { z } from "zod";
import { defineOp, HelperOpError, type HelperContext, type HelperOp } from "../ops.ts";
import { createAuthFileStore } from "./auth-store.ts";
import {
  commitText,
  INVALID_ROOT,
  invalid,
  maskOrRefuse,
  piRejects,
  readCurrent,
  revisionOf,
  tooLarge,
} from "./models-json-shared.ts";
import { applyProvider, type Applied, parseStrict, removeProvider } from "./provider-apply.ts";
import { viewOf } from "./provider-view.ts";

type Params<N extends keyof typeof HELPER_OPS> = z.infer<(typeof HELPER_OPS)[N]["params"]>;
type GetResult = z.infer<(typeof HELPER_OPS)["models.provider.get"]["result"]>;

const builtinIds = async (): Promise<ReadonlySet<string>> => {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  return new Set(builtinProviders().map((provider) => provider.id));
};

/** null: the file is not strict JSON, or `providers` is not an object (the raw editor's). */
const providersTable = (text: string | null): Record<string, unknown> | null => {
  const root = text === null ? { providers: {} } : parseStrict(text);
  if (root === null) return null;
  if (root.providers === undefined) return {};
  const { providers } = root;
  return typeof providers === "object" && providers !== null && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)
    : null;
};

/**
 * The ids `auth.json` holds a credential for (never a value; nothing is resolved, no command runs). Pi uses a stored
 * credential before the `apiKey` of `models.json`, so the form warns about it. Only a notice depends on it: a damaged or
 * refused `auth.json` gives no ids here and the form opens all the same (the key flow reports that file's own errors).
 */
async function storedKeyIds(ctx: HelperContext): Promise<string[]> {
  try {
    return (await createAuthFileStore(ctx).list()).map((one) => one.providerId).sort();
  } catch {
    return [];
  }
}

export const providerGet: HelperOp<Params<"models.provider.get">, GetResult> = {
  params: HELPER_OPS["models.provider.get"].params,
  run: async (params, ctx) => {
    const current = await readCurrent(ctx);
    const revision = revisionOf(params.revisionKey, current);
    // A file that is not strict JSON is never shown as editable (MPR11): the raw editor owns it, whatever the id.
    const providers = providersTable(current);
    if (providers === null) return { editable: false, reason: "needs_raw_editor", revision };
    if (params.id === undefined) {
      const storedKeys = (await storedKeyIds(ctx)).filter((id) => id.length <= 128).slice(0, 300);
      return {
        editable: false,
        reason: "not_in_file",
        revision,
        ...(storedKeys.length > 0 ? { storedKeys } : {}),
      };
    }
    if ((await builtinIds()).has(params.id)) return { editable: false, reason: "builtin", revision };
    if (!Object.hasOwn(providers, params.id)) return { editable: false, reason: "not_in_file", revision };
    const view = viewOf(params.id, providers[params.id]);
    if (!view.editable) return { ...view, revision };
    const keyStored = (await storedKeyIds(ctx)).includes(params.id);
    return {
      editable: true,
      provider: view.provider,
      revision,
      advanced: view.advanced,
      ...(keyStored ? { keyStored: true as const } : {}),
    };
  },
};

/** The candidate, or the refusal. Save and remove both rewrite the file (pretty-printed), so both answer to the editor's size test. */
function textOrStop(applied: Applied): string | ConfigSaveResult {
  if ("fail" in applied) throw new HelperOpError(applied.fail, applied.fail);
  if ("issues" in applied) return invalid(applied.issues);
  if (tooLarge(maskOrRefuse(applied.text).masked)) return invalid(["text too large"]);
  return applied.text;
}

export const providerSave: HelperOp<Params<"models.provider.save">, ConfigSaveResult> = {
  params: HELPER_OPS["models.provider.save"].params,
  run: async (params, ctx) => {
    const current = await readCurrent(ctx);
    if (revisionOf(params.revisionKey, current) !== params.baseRevision)
      throw new HelperOpError("conflict", "revision");
    const text = textOrStop(applyProvider(current, params.provider, params.mode, await builtinIds()));
    if (typeof text !== "string") return text;
    if (await piRejects(text, ctx)) return invalid(INVALID_ROOT);
    return commitText(ctx, params.revisionKey, params.baseRevision, current, text);
  },
};

/**
 * Any non-built-in id the file holds, also one the form cannot edit (MP-RT-02). Pi's loader is not asked: the odd
 * provider being removed may be exactly what it rejects, and a removal cannot make the file worse.
 */
export const providerRemove: HelperOp<Params<"models.provider.remove">, ConfigSaveResult> = {
  params: HELPER_OPS["models.provider.remove"].params,
  run: async (params, ctx) => {
    const current = await readCurrent(ctx);
    if (revisionOf(params.revisionKey, current) !== params.baseRevision)
      throw new HelperOpError("conflict", "revision");
    if (current === null) throw new HelperOpError("not_found", "file");
    const text = textOrStop(removeProvider(current, params.id, await builtinIds()));
    if (typeof text !== "string") return text;
    return commitText(ctx, params.revisionKey, params.baseRevision, current, text);
  },
};

export const providerGetOp = defineOp(providerGet);
export const providerSaveOp = defineOp(providerSave);
export const providerRemoveOp = defineOp(providerRemove);
