import { cleanUpJudges, entryProvider, type ExtensionProviders, type ProviderView } from "@pap/contracts";
import { stripHidden } from "../../../lib/untrusted-text.ts";
import { groupAndRank, shownText, type PickerGroup } from "../picker/model-picker.vm.ts";
import type { AvailableState } from "../picker/use-available-models.ts";

export type AvailabilityMode = "all" | "selection";

/** `all` while `enabledModels` has no list (every model of a connected provider is offered), else `selection`. */
export const modeOf = (patterns: readonly string[] | null): AvailabilityMode =>
  patterns === null ? "all" : "selection";

export interface ModelRow {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}

export interface ProviderRow {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly total: number;
  readonly enabled: number;
  /** Models of this provider the preview lists; 0 for a provider that is not connected; null while the preview is not ready. */
  readonly offered: number | null;
  readonly models: readonly ModelRow[];
  readonly modelsTruncated: boolean;
}

/** One row per provider of the overview; the offered count is the preview's, never derived from the switches. */
export function providerRows(providers: readonly ProviderView[], available: AvailableState): ProviderRow[] {
  const offered = new Map<string, number>();
  if (available.status === "ready")
    for (const model of available.models) offered.set(model.provider, (offered.get(model.provider) ?? 0) + 1);
  return providers.map((provider) => {
    const connected = provider.auth.configured;
    return {
      id: provider.id,
      name: shownText(provider.name),
      connected,
      total: provider.models.length,
      enabled: provider.models.filter((model) => model.enabled).length,
      offered: !connected ? 0 : available.status === "ready" ? (offered.get(provider.id) ?? 0) : null,
      models: provider.models.map((model) => ({
        id: model.id,
        label: shownText(model.name === "" ? model.id : model.name),
        enabled: model.enabled,
      })),
      modelsTruncated: provider.modelsTruncated,
    };
  });
}

const UNMATCHED = /^No model matches "([\s\S]*)"\.$/;

export interface UnmatchedRow {
  /** The helper's own sentence, cleaned. */
  readonly text: string;
  /**
   * Why Clean up keeps it (`cleanUpJudges`, the helper's own rule): `extension`, a provider the extensions read in this
   * tab add; `unjudged`, any other entry naming no provider this view knows. null: Clean up removes it.
   */
  readonly kept: "extension" | "unjudged" | null;
}

/** The overview warnings that say an entry of the list matches nothing, and what Clean up does with each. */
export function unmatchedRows(
  warnings: readonly string[],
  providers: readonly ProviderView[],
  extensionProviders: ReadonlySet<string>,
): UnmatchedRow[] {
  const known = new Set(providers.map((provider) => provider.id));
  return warnings.flatMap((warning) => {
    const entry = UNMATCHED.exec(warning)?.[1];
    if (entry === undefined) return [];
    const kept = cleanUpJudges(entry, known)
      ? null
      : extensionProviders.has(entryProvider(entry) ?? "")
        ? "extension"
        : "unjudged";
    return [{ text: stripHidden(warning), kept }];
  });
}

/** The preview's groups, by provider, in the order of the answer. */
export const previewGroups = (available: AvailableState): PickerGroup[] =>
  available.status === "ready" ? groupAndRank(available.models, available.labels, "") : [];

export interface ExtensionModelRow {
  /** Pi's own id, for a write; never shown. */
  readonly modelId: string;
  /** The id as shown (cleaned). */
  readonly id: string;
  readonly label: string;
  readonly offered: boolean;
  readonly enabled: boolean;
}

export interface ExtensionRow {
  /** Pi's own provider id, for a write; never shown. */
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly overrides: boolean;
  readonly modelsTruncated: boolean;
  readonly models: readonly ExtensionModelRow[];
}

/**
 * Extension providers as shown (MPR26, MPR-C8): ids and names cleaned. The daemon leaves out an extension that
 * re-registers a built-in id (M4); one that re-registers a models.json provider is listed and marked `overrides`.
 */
export function extensionRows(
  answer: { readonly providers: readonly ExtensionProviders["providers"][number][] },
  providers: readonly ProviderView[],
): ExtensionRow[] {
  const own = new Set(providers.filter((provider) => provider.origin === "models.json").map((one) => one.id));
  return answer.providers.map((provider) => ({
    provider: provider.id,
    id: shownText(provider.id),
    name: shownText(provider.name),
    overrides: own.has(provider.id),
    modelsTruncated: provider.modelsTruncated,
    models: provider.models.map((model) => ({
      modelId: model.id,
      id: shownText(model.id),
      label: shownText(model.name === "" ? model.id : model.name),
      offered: model.offered,
      enabled: model.enabled,
    })),
  }));
}
