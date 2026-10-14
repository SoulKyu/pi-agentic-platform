import type { ModelSummary } from "@pap/contracts";
import { t } from "../../i18n/index.ts";
import { failureCode, failureText } from "./failure.ts";

export interface ModelRow {
  readonly model: ModelSummary;
  readonly current: boolean;
  readonly isDefault: boolean;
}

export interface ProviderGroup {
  readonly provider: string;
  readonly rows: readonly ModelRow[];
}

interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

/** The defaults `models.overview` reports; null while they are not known. */
interface Defaults {
  readonly provider: string | null;
  readonly model: string | null;
}

const matches = (model: ModelSummary, needle: string): boolean =>
  [model.provider, model.id, model.name].some((field) => field.toLowerCase().includes(needle));

/**
 * The model menu's rows: grouped by provider in the order the list shows them first, models in list order (never
 * re-sorted, pi-web #783), filtered by provider, id or name. Exactly one row is `current`, and one is the default.
 */
export function groupModels(
  models: readonly ModelSummary[],
  query: string,
  current: ModelRef | null,
  defaults: Defaults | null,
): ProviderGroup[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, ModelRow[]>();
  for (const model of models) {
    if (needle !== "" && !matches(model, needle)) continue;
    const rows = groups.get(model.provider) ?? [];
    rows.push({
      model,
      current: current !== null && current.provider === model.provider && current.id === model.id,
      isDefault: defaults !== null && defaults.provider === model.provider && defaults.model === model.id,
    });
    groups.set(model.provider, rows);
  }
  return [...groups].map(([provider, rows]) => ({ provider, rows }));
}

/** What a failed default (model or level) says: the project's own file decides it, or the code's fixed text. */
export const defaultFailureText = (failure: unknown): string =>
  failureCode(failure) === "project_scope" ? t("sessionModels.menu.projectScope") : failureText(failure);
