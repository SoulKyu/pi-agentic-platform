import { Button, DENSITIES, Segmented, Slider } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { SIZE_RANGES, type DeviceAppearance } from "./model.ts";

type SizeField = keyof typeof SIZE_RANGES;
const SIZE_FIELDS = ["uiSize", "chatSize", "codeSize"] as const satisfies readonly SizeField[];
/** What each density sets in tokens.css, shown while a size follows it. */
const DENSITY_SIZES: Record<DeviceAppearance["density"], Record<SizeField, number>> = {
  compact: { uiSize: 13, chatSize: 14, codeSize: 12 },
  comfortable: { uiSize: 14, chatSize: 15, codeSize: 12.5 },
  mixed: { uiSize: 13, chatSize: 15, codeSize: 12 },
};
const WIDTHS = ["full", "wide", "narrow"] as const;
const MOTIONS = ["system", "reduced", "none"] as const;

/** Device scope: density, the three text sizes, chat width and motion. */
export function ReadingSection() {
  const t = useT();
  const device = useAppearanceStore((state) => state.device);
  const setDevice = useAppearanceStore((state) => state.setDevice);
  return (
    <AppearanceSection
      title={t("settings.appearance.section.reading")}
      scope={t("settings.appearance.scopeDevice")}
    >
      <Segmented
        label={t("settings.appearance.density.label")}
        value={device.density}
        options={DENSITIES.map((value) => ({ value, label: t(`settings.appearance.density.${value}`) }))}
        onChange={(density) => setDevice({ ...device, density })}
      />
      {SIZE_FIELDS.map((field) => {
        const [min, max] = SIZE_RANGES[field];
        const own = device[field];
        return (
          <div key={field} className="flex items-end gap-s2">
            <div className="min-w-0 flex-1">
              <Slider
                label={t(`settings.appearance.${field}`)}
                value={own ?? DENSITY_SIZES[device.density][field]}
                min={min}
                max={max}
                onChange={(value) => setDevice({ ...device, [field]: value })}
                valueText={(value) => t("settings.appearance.px", { value })}
              />
            </div>
            {own === null ? null : (
              <Button variant="ghost" size="sm" onClick={() => setDevice({ ...device, [field]: null })}>
                {t("settings.appearance.followDensity")}
              </Button>
            )}
          </div>
        );
      })}
      <Segmented
        label={t("settings.appearance.chatWidth.label")}
        value={device.chatWidth}
        options={WIDTHS.map((value) => ({ value, label: t(`settings.appearance.chatWidth.${value}`) }))}
        onChange={(chatWidth) => setDevice({ ...device, chatWidth })}
      />
      <Segmented
        label={t("settings.appearance.motion.label")}
        value={device.motion}
        options={MOTIONS.map((value) => ({ value, label: t(`settings.appearance.motion.${value}`) }))}
        onChange={(motion) => setDevice({ ...device, motion })}
      />
    </AppearanceSection>
  );
}
