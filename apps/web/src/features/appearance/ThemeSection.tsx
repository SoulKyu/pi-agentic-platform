import { Segmented, Select, type Option } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { CustomThemes } from "./CustomThemes.tsx";
import { useAppearanceStore } from "./appearance-store.ts";

const MODES = ["night", "day", "system"] as const;

/** Account scope: the mode and the theme of each side. The custom theme library sits below. */
export function ThemeSection() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  const custom = (base: "night" | "day"): Option<string>[] =>
    account.customThemes
      .filter((theme) => theme.base === base)
      .map((theme) => ({ value: theme.id, label: theme.name }));
  const dark: Option<string>[] = [
    { value: "night", label: t("settings.appearance.preset.night") },
    { value: "hc", label: t("settings.appearance.preset.hc") },
    ...custom("night"),
  ];
  const light: Option<string>[] = [
    { value: "day", label: t("settings.appearance.preset.day") },
    ...custom("day"),
  ];
  return (
    <AppearanceSection
      title={t("settings.appearance.section.theme")}
      scope={t("settings.appearance.scopeAccount")}
    >
      <Segmented
        label={t("settings.appearance.mode.label")}
        value={account.mode}
        options={MODES.map((value) => ({ value, label: t(`settings.appearance.mode.${value}`) }))}
        onChange={(mode) => setAccount({ ...account, mode })}
      />
      <Select
        label={t("settings.appearance.darkTheme")}
        value={account.darkTheme}
        options={dark}
        onChange={(darkTheme) => setAccount({ ...account, darkTheme })}
      />
      <Select
        label={t("settings.appearance.lightTheme")}
        value={account.lightTheme}
        options={light}
        onChange={(lightTheme) => setAccount({ ...account, lightTheme })}
      />
      <CustomThemes />
    </AppearanceSection>
  );
}
