import { z } from "zod";
import { defineMethod } from "./define.ts";
import { ModelSummary } from "./session-loadout.ts";

/** Same number as `MODELS_LIMITS.providers`; not imported, `models-methods.ts` spreads this file in. */
export const EXTENSION_PROVIDERS_MAX = 300;
export const EXTENSION_MODELS_MAX = 500;

/**
 * A model an extension registers. `offered`: the no-session rule (`listAvailable`, the global selection, no project)
 * offers it, so an agent's worker accepts it; the pickers list only these. `enabled`: the global selection names it
 * (true with no selection), what Settings' switch shows (ADR 0070, amended 2026-10-18).
 */
export const ExtensionModel = ModelSummary.extend({ offered: z.boolean(), enabled: z.boolean() }).strict();
export type ExtensionModel = z.infer<typeof ExtensionModel>;

/**
 * The provider an `enabledModels` entry names (`provider/model`, an optional `:level` after it), or null when it names
 * none: a bare id, a fuzzy match, or a glob in the provider part. Pi matches all of these against every model, an
 * extension's included.
 */
export function entryProvider(entry: string): string | null {
  const slash = entry.indexOf("/");
  if (slash <= 0) return null;
  const provider = entry.slice(0, slash);
  return /[*?[\]]/.test(provider) ? null : provider;
}

/**
 * Whether "Clean up" (`prune`) may judge an entry that matches nothing: only when it names a provider the view without
 * extensions knows. Any other entry may match a model an extension adds, so Clean up keeps it.
 */
export const cleanUpJudges = (entry: string, known: ReadonlySet<string>): boolean => {
  const provider = entryProvider(entry);
  return provider !== null && known.has(provider);
};

/**
 * The providers the owner's global extensions register, as Pi's offline load of them sees them (MPR17). A model list,
 * never a base URL, a header or a key: the schema is strict at both levels so none can ride along.
 */
export const ExtensionProviders = z
  .object({
    providers: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            name: z.string().max(256),
            models: z.array(ExtensionModel).max(EXTENSION_MODELS_MAX),
            modelsTruncated: z.boolean(),
          })
          .strict(),
      )
      .max(EXTENSION_PROVIDERS_MAX),
    /** The list is not complete: the providers cap or the byte budget stopped it, or a provider id did not fit (MPR-C8). */
    truncated: z.boolean(),
    /** An extension failed to load; nothing was guessed (fail closed, as models.usage). */
    failed: z.boolean(),
  })
  .strict();
export type ExtensionProviders = z.infer<typeof ExtensionProviders>;

export const modelsExtensionsMethods = {
  // Runs the owner's global extensions on their click, so `pi:admin`: a token never triggers extension code.
  "models.extensions": defineMethod({
    name: "models.extensions",
    permission: "pi:admin",
    idempotent: true,
    params: z.object({}).strict(),
    result: ExtensionProviders,
    errors: ["capacity", "timeout", "helper_failed", "config_invalid", "config_path_refused"],
  }),
} as const;
