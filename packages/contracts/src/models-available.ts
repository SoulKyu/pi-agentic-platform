import { z } from "zod";
import { ClientPath } from "./client-path.ts";
import { defineMethod } from "./define.ts";
import { ModelSummary } from "./session-loadout.ts";

/** Same number as `MODELS_LIMITS.models` and `.providers`; not imported, `models-methods.ts` spreads this file in. */
export const AVAILABLE_MODELS_MAX = 2000;
export const AVAILABLE_PROVIDERS_MAX = 300;

/**
 * The models a context without a session may pick from (MPR1): what Pi would let a session use. Nothing secret rides
 * along: no key, no header, no path, no warning (the overview owns those).
 */
export const AvailableModels = z
  .object({
    models: z.array(ModelSummary.strict()).max(AVAILABLE_MODELS_MAX),
    /** Providers of `models`, in first-appearance order, with their display names (clipped at 256). */
    providers: z
      .array(z.object({ id: z.string().min(1).max(128), name: z.string().max(256) }).strict())
      .max(AVAILABLE_PROVIDERS_MAX),
    /**
     * Every provider Pi has without extensions (built-in and `models.json`), offered or not, at most 300: a picker says a
     * saved model "may come from an extension" only when its provider is not here. Absent from an older daemon.
     */
    providerIds: z.array(z.string().min(1).max(128)).max(AVAILABLE_PROVIDERS_MAX).optional(),
    /** No `session` here: the helper has no session. */
    origin: z.enum(["scope", "signed-in"]),
    /** Models were left out to stay within the count or the byte budget. */
    truncated: z.boolean(),
  })
  .strict();
export type AvailableModels = z.infer<typeof AvailableModels>;

export const modelsAvailableMethods = {
  // `cwd` must be a folder the caller has a session or project in (M7R50), else `invalid_cwd`.
  "models.available": defineMethod({
    name: "models.available",
    permission: "pi:read",
    idempotent: true,
    params: z.object({ cwd: ClientPath.optional() }).strict(),
    result: AvailableModels,
    errors: ["invalid_cwd", "capacity", "timeout", "helper_failed", "config_invalid", "config_path_refused"],
  }),
} as const;
