import { LANE_LIMITS, type ModelPick } from "@pap/contracts";
import { Button, IconButton, IconClose } from "@pap/ui";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { ModelPickerField } from "../models/picker/index.ts";
import type { Slot } from "./new-lane.vm.ts";

interface Props {
  readonly slots: readonly Slot[];
  /** The project's folder: a lane's models are the ones Pi offers there (MPR4). Null while no project is picked. */
  readonly cwd: string | null;
  readonly disabled: boolean;
  onModel(key: number, model: ModelPick | null): void;
  onAdd(): void;
  onRemove(key: number): void;
}

/** "Agent and model": one model row per lane, 1 to 4. The agent half comes with M11 (board 10 §3). */
export function ModelSlots({ slots, cwd, disabled, onModel, onAdd, onRemove }: Props) {
  const t = useT();
  const locale = useLocale();
  return (
    <fieldset data-slot="model-slots" className="flex min-w-0 flex-col gap-s2">
      <legend className="label-hud text-muted">{t("laneNew.agent")}</legend>
      {slots.map((slot, index) => (
        <div key={slot.key} className="flex items-end gap-s1">
          <div className="min-w-0 flex-1">
            <ModelPickerField
              label={t("laneNew.model.label", { n: index + 1 })}
              value={slot.model}
              cwd={cwd}
              defaultLabel={t("laneNew.model.default")}
              disabled={disabled}
              onChange={(model) => onModel(slot.key, model)}
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
