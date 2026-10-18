import { Button, Chip, Switch } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../../i18n/index.ts";
import type { ExtensionRow } from "./availability.vm.ts";

/** Models drawn at first, as the other provider rows do (`ProviderRows`). */
const MODELS_SHOWN = 100;

/** How the extension rows write the selection: the same `models.setEnabled` ops and pending keys as the other rows. */
export interface ExtensionSelection {
  /** "All the models", a project's selection, or a write the screen cannot make: the switches show and do not move. */
  readonly disabled: boolean;
  readonly pending: ReadonlySet<string>;
  onProvider(provider: string, on: boolean): void;
  onModel(provider: string, modelId: string, on: boolean): void;
}

/**
 * One provider an extension adds: its switch (every model), a switch per model, and what the pickers make of them
 * ("not offered": outside the selection, or a provider with no key). Writes carry Pi's own ids, never the cleaned ones.
 */
export function ExtensionRowItem({
  row,
  selection,
}: {
  readonly row: ExtensionRow;
  readonly selection: ExtensionSelection;
}) {
  const t = useT();
  const [shown, setShown] = useState(MODELS_SHOWN);
  const total = row.models.length;
  const on = row.models.filter((model) => model.enabled).length;
  const allOn = total > 0 && on === total;
  const label = row.name === "" ? row.id : row.name;
  return (
    <li
      data-extension-provider={row.id}
      data-overrides={row.overrides ? "true" : "false"}
      className="flex flex-col gap-s1"
    >
      <div className="flex flex-wrap items-center gap-s2">
        <div className="min-w-0 flex-1">
          <Switch
            label={label}
            checked={allOn}
            disabled={selection.disabled || total === 0 || selection.pending.has(`p:${row.provider}`)}
            onChange={(next) => selection.onProvider(row.provider, next)}
            {...(!allOn && on > 0 ? { hint: t("settingsAvailability.partial", { on, total }) } : {})}
          />
        </div>
        {row.overrides ? <Chip tone="att" label={t("settingsAvailability.extensions.overrides")} /> : null}
      </div>
      {row.overrides ? (
        <p className="text-ui text-muted">{t("settingsAvailability.extensions.overridesNote")}</p>
      ) : null}
      {total === 0 ? (
        <p className="text-ui text-muted">{t("settingsAvailability.extensions.noModels")}</p>
      ) : (
        <ul className="flex flex-col gap-s1 pl-s4">
          {row.models.slice(0, shown).map((model, at) => (
            <li
              key={`${at}:${model.modelId}`}
              data-extension-model={model.id}
              data-offered={model.offered ? "true" : "false"}
            >
              <Switch
                label={model.label}
                checked={model.enabled}
                disabled={selection.disabled || selection.pending.has(`m:${row.provider}/${model.modelId}`)}
                onChange={(next) => selection.onModel(row.provider, model.modelId, next)}
                {...(model.offered ? {} : { hint: t("settingsAvailability.extensions.notOffered") })}
              />
            </li>
          ))}
        </ul>
      )}
      {total > shown ? (
        <div>
          <Button onClick={() => setShown((count) => count + MODELS_SHOWN)}>
            {t("settingsAvailability.models.more", { count: total - shown })}
          </Button>
        </div>
      ) : null}
      {row.modelsTruncated ? (
        <p className="text-ui text-muted">{t("settingsAvailability.extensions.modelsTruncated")}</p>
      ) : null}
    </li>
  );
}
