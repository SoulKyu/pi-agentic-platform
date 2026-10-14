import type { ModelsOverview } from "@pap/contracts";

export const STEPS = ["account", "passkey", "pi"] as const;
export type Step = (typeof STEPS)[number];

export const nextStep = (step: Step): Step | null => STEPS[STEPS.indexOf(step) + 1] ?? null;

export type PiSummary =
  | { readonly kind: "ready"; readonly provider: string | null; readonly model: string | null }
  | { readonly kind: "choose" };

/**
 * Whether Pi can answer already: a provider signed in, or one whose environment variable is set. A provider whose
 * sign-in files could not be read does not count (never guessed). The default model is shown when there is one.
 */
export function piSummary(overview: Pick<ModelsOverview, "providers" | "defaults">): PiSummary {
  const signedIn = overview.providers.some(
    (provider) =>
      (provider.auth.status === "known" && provider.auth.configured) ||
      provider.auth.env.some((variable) => variable.set),
  );
  if (!signedIn) return { kind: "choose" };
  const { provider, model } = overview.defaults;
  return provider !== null && model !== null
    ? { kind: "ready", provider, model }
    : { kind: "ready", provider: null, model: null };
}
