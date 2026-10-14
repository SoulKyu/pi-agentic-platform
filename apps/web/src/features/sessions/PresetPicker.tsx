import type { ToolPreset } from "@pap/contracts";
import { Select } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import "./register-tools-catalog.ts";
import { PRESET_ORDER } from "./presets.vm.ts";

/** The tool preset field of the new-session form; the hint says what the chosen preset allows. */
export default function PresetPicker({
  value,
  onChange,
  disabled,
}: {
  readonly value: ToolPreset;
  onChange(value: ToolPreset): void;
  readonly disabled?: boolean;
}) {
  const t = useT();
  return (
    <Select<ToolPreset>
      label={t("sessionTools.field")}
      value={value}
      options={PRESET_ORDER.map((preset) => ({ value: preset, label: t(`sessionTools.name.${preset}`) }))}
      onChange={onChange}
      hint={t(`sessionTools.about.${value}`)}
      disabled={disabled}
    />
  );
}
