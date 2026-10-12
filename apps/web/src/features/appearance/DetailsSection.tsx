import { Segmented, Select, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";

const RAILS = ["left", "right"] as const;
const AVATARS = ["outlined", "tinted", "glyph"] as const;
const TOOL_DETAILS = ["compact", "expanded", "full"] as const;

/** Account scope: the two bundled font families or the system stacks (M3R110), labels, grid, rail, avatars, tool cards. */
export function DetailsSection() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  return (
    <AppearanceSection
      title={t("settings.appearance.section.details")}
      scope={t("settings.appearance.scopeAccount")}
    >
      <Select
        label={t("settings.appearance.uiFont")}
        value={account.uiFont}
        options={[
          { value: "manrope", label: t("settings.appearance.fontManrope") },
          { value: "system", label: t("settings.appearance.fontSystem") },
        ]}
        onChange={(uiFont) => setAccount({ ...account, uiFont })}
      />
      <Select
        label={t("settings.appearance.monoFont")}
        value={account.monoFont}
        options={[
          { value: "jetbrains-mono", label: t("settings.appearance.fontJetbrains") },
          { value: "system", label: t("settings.appearance.fontSystem") },
        ]}
        onChange={(monoFont) => setAccount({ ...account, monoFont })}
      />
      <Switch
        label={t("settings.appearance.uppercaseLabels")}
        checked={account.uppercaseLabels}
        onChange={(uppercaseLabels) => setAccount({ ...account, uppercaseLabels })}
      />
      <Switch
        label={t("settings.appearance.grid")}
        checked={account.grid}
        onChange={(grid) => setAccount({ ...account, grid })}
      />
      <Segmented
        label={t("settings.appearance.rail.label")}
        value={account.railPosition}
        options={RAILS.map((value) => ({ value, label: t(`settings.appearance.rail.${value}`) }))}
        onChange={(railPosition) => setAccount({ ...account, railPosition })}
      />
      <Segmented
        label={t("settings.appearance.avatar.label")}
        value={account.avatarStyle}
        options={AVATARS.map((value) => ({ value, label: t(`settings.appearance.avatar.${value}`) }))}
        onChange={(avatarStyle) => setAccount({ ...account, avatarStyle })}
      />
      <Segmented
        label={t("settings.appearance.toolDetail.label")}
        value={account.toolDetail}
        options={TOOL_DETAILS.map((value) => ({
          value,
          label: t(`settings.appearance.toolDetail.${value}`),
        }))}
        onChange={(toolDetail) => setAccount({ ...account, toolDetail })}
      />
    </AppearanceSection>
  );
}
