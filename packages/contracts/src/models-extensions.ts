import { z } from "zod";
import { defineMethod } from "./define.ts";
import { ModelSummary } from "./session-loadout.ts";

/** Same number as `MODELS_LIMITS.providers`; not imported, `models-methods.ts` spreads this file in. */
export const EXTENSION_PROVIDERS_MAX = 300;
export const EXTENSION_MODELS_MAX = 500;

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
            models: z.array(ModelSummary.strict()).max(EXTENSION_MODELS_MAX),
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
