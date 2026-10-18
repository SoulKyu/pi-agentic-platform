import type { ExtensionProviders } from "@pap/contracts";
import { modelKey, shownText, toPickerModel, type PickerModel } from "./model-picker.vm.ts";

export interface ExtensionView {
  /** The offered models only an extension registers, in the answer's order. */
  readonly models: readonly PickerModel[];
  /** Provider labels, cleaned (MPR26). */
  readonly labels: ReadonlyMap<string, string>;
  /** Providers whose model list the read cut short. */
  readonly modelsTruncated: ReadonlySet<string>;
  /** Every model the answer holds, offered or not. */
  readonly total: number;
  /** Models of an extension the no-session rule does not offer: an agent's worker would refuse them. */
  readonly unoffered: number;
  /** The answer's own flags: an extension failed to load; providers are missing. */
  readonly failed: boolean;
  readonly truncated: boolean;
}

/**
 * What a picker adds from a `models.extensions` answer (ADR 0070 as amended): the offered models, minus those the
 * list already has (a provider an extension overrides may share some). Names are cleaned by `toPickerModel`.
 */
export function extensionView(answer: ExtensionProviders, listed: readonly PickerModel[]): ExtensionView {
  const known = new Set(listed.map(modelKey));
  const models: PickerModel[] = [];
  const labels = new Map<string, string>();
  const modelsTruncated = new Set<string>();
  let total = 0;
  let unoffered = 0;
  for (const provider of answer.providers) {
    labels.set(provider.id, shownText(provider.name === "" ? provider.id : provider.name));
    if (provider.modelsTruncated) modelsTruncated.add(provider.id);
    for (const { offered, ...summary } of provider.models) {
      total += 1;
      if (!offered) unoffered += 1;
      else if (!known.has(modelKey(summary))) models.push(toPickerModel(summary));
    }
  }
  return {
    models,
    labels,
    modelsTruncated,
    total,
    unoffered,
    failed: answer.failed,
    truncated: answer.truncated,
  };
}

const sameModel = (model: { provider: string; id: string }, ref: { provider: string; modelId: string }) =>
  model.provider === ref.provider && model.id === ref.modelId;

/** True when the list, or what the extensions added to it, offers this saved model. */
export const isOffered = (
  ref: { readonly provider: string; readonly modelId: string },
  listed: readonly PickerModel[],
  extension: ExtensionView | null,
): boolean =>
  listed.some((model) => sameModel(model, ref)) ||
  (extension?.models.some((model) => sameModel(model, ref)) ?? false);

/**
 * A saved model the list does not offer, whose provider the list does not know either, may be an extension's while the
 * extensions are not read, or were read incompletely: say so, never "no longer offered" (the run checks it).
 */
export function mayBeExtension(
  ref: { readonly provider: string },
  providers: { has(provider: string): boolean },
  extension: ExtensionView | null,
): boolean {
  if (providers.has(ref.provider)) return false;
  return (
    extension === null ||
    extension.failed ||
    extension.truncated ||
    extension.modelsTruncated.has(ref.provider)
  );
}
