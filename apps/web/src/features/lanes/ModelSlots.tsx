import { LANE_LIMITS, type ModelPick } from "@pap/contracts";
import { Button, IconButton, IconClose, Select } from "@pap/ui";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import type { ModelChoice, Slot } from "./new-lane.vm.ts";

const DEFAULT = "default";

interface Props {
  readonly slots: readonly Slot[];
  readonly choices: readonly ModelChoice[];
  readonly truncated: boolean;
  readonly disabled: boolean;
  onModel(key: number, model: ModelPick | null): void;
  onAdd(): void;
  onRemove(key: number): void;
}

const valueOf = (model: ModelPick | null, choices: readonly ModelChoice[]): string => {
  const at =
    model === null ? -1 : choices.findIndex((c) => c.provider === model.provider && c.id === model.modelId);
  return at === -1 ? DEFAULT : `m${at}`;
};

/** "Agent and model": one model row per lane, 1 to 4. The agent half comes with M11 (board 10 §3). */
export function ModelSlots({ slots, choices, truncated, disabled, onModel, onAdd, onRemove }: Props) {
  const t = useT();
  const locale = useLocale();
  const options = [
    { value: DEFAULT, label: t("laneNew.model.default") },
    ...choices.map((choice, index) => ({ value: `m${index}`, label: choice.name || choice.id })),
  ];
  return (
    <fieldset data-slot="model-slots" className="flex min-w-0 flex-col gap-s2">
      <legend className="label-hud text-muted">{t("laneNew.agent")}</legend>
      {slots.map((slot, index) => (
        <div key={slot.key} className="flex items-end gap-s1">
          <div className="min-w-0 flex-1">
            <Select
              label={t("laneNew.model.label", { n: index + 1 })}
              value={valueOf(slot.model, choices)}
              options={options}
              disabled={disabled}
              onChange={(value) => {
                const choice = value === DEFAULT ? undefined : choices[Number(value.slice(1))];
                onModel(
                  slot.key,
                  choice === undefined ? null : { provider: choice.provider, modelId: choice.id },
                );
              }}
            />
          </div>
          {slots.length > 1 ? (
            <IconButton
              icon={IconClose}
              size="sm"
              label={t("laneNew.model.remove", { n: index + 1 })}
              disabled={disabled}
              onClick={() => onRemove(slot.key)}
            />
          ) : null}
        </div>
      ))}
      {truncated ? <p className="text-ui text-muted">{t("laneNew.model.truncated")}</p> : null}
      <div className="flex items-center gap-s2">
        <span className="label-hud text-muted">{t("laneNew.fanout")}</span>
        <span className="text-ui text-fg">
          {plural(locale, "laneNew.fanout", slots.length)}{" "}
          <span className="text-muted">{t("laneNew.fanout.upTo")}</span>
        </span>
        <Button size="sm" disabled={disabled || slots.length >= LANE_LIMITS.fanout} onClick={onAdd}>
          {t("laneNew.model.add")}
        </Button>
      </div>
    </fieldset>
  );
}
