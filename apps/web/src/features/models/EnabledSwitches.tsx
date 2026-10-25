import type { ProviderView } from "@pap/contracts";
import { Button, Switch, Heading } from "@pap/ui";
import { StarButton } from "./StarButton.tsx";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { providerSwitch } from "./models.vm.ts";

/** Models drawn at first; a provider with hundreds (a gateway) shows the rest on request. */
const MODELS_SHOWN = 100;

export interface SwitchHandlers {
  onProvider(on: boolean): void;
  onModel(modelId: string, on: boolean): void;
  onStar(modelId: string): void;
}

/**
 * The provider switch (on only while every model is on, otherwise off with its n/m count), one switch per model and
 * the default star. A switch whose write is pending is disabled; a project scope disables all of them, and the note
 * above says why in text (never a tooltip, M7R68).
 */
export function EnabledSwitches({
  provider,
  readOnly,
  pending,
  defaultModel,
  handlers,
}: {
  readonly provider: ProviderView;
  readonly readOnly: boolean;
  readonly pending: ReadonlySet<string>;
  readonly defaultModel: string | null;
  readonly handlers: SwitchHandlers;
}) {
  const t = useT();
  const [shown, setShown] = useState(MODELS_SHOWN);
  const all = providerSwitch(provider.models);
  const providerKey = `p:${provider.id}`;
  const visible = provider.models.slice(0, shown);
  return (
    <div className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsModels.models.title")}
      </Heading>
      {provider.models.length === 0 ? (
        <p className="text-ui text-muted">{t("settingsModels.models.empty")}</p>
      ) : (
        <>
          <Switch
            label={t("settingsModels.switch.provider", { provider: provider.name })}
            checked={all.on}
            disabled={readOnly || pending.has(providerKey)}
            onChange={handlers.onProvider}
            {...(!all.on && all.enabled > 0
              ? { hint: t("settingsModels.switch.partial", { on: all.enabled, total: all.total }) }
              : {})}
          />
          <p className="text-ui text-muted">{t("settingsModels.star.note")}</p>
          <ul className="flex flex-col gap-s1">
            {visible.map((model) => {
              const label = model.name === "" ? model.id : model.name;
              const isDefault = defaultModel === model.id;
              return (
                <li key={model.id} data-model={model.id} className="flex items-center gap-s2">
                  <div className="min-w-0 flex-1">
                    <Switch
                      label={label}
                      checked={model.enabled}
                      disabled={readOnly || pending.has(`m:${provider.id}/${model.id}`)}
                      onChange={(on) => handlers.onModel(model.id, on)}
                    />
                  </div>
                  <StarButton
                    label={t("settingsModels.star.set", { model: label })}
                    isDefault={isDefault}
                    disabled={readOnly || !model.enabled || pending.has("default")}
                    onPress={() => handlers.onStar(model.id)}
                  />
                </li>
              );
            })}
          </ul>
          {provider.models.length > shown ? (
            <div>
              <Button onClick={() => setShown((count) => count + MODELS_SHOWN)}>
                {t("settingsModels.models.more", { count: provider.models.length - shown })}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {provider.modelsTruncated ? (
        <p className="text-ui text-muted">{t("settingsModels.models.truncated")}</p>
      ) : null}
    </div>
  );
}
