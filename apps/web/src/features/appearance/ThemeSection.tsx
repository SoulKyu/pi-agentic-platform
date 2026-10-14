import type { CustomTheme } from "@pap/contracts";
import { PRESET_TOKENS, Segmented, type ThemeName } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { CustomThemes } from "./CustomThemes.tsx";
import { ThemeCards, type ThemeCardOption } from "./ThemeCards.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { deriveTheme } from "./derive.ts";

const MODES = ["night", "day", "system"] as const;

const presetSwatch = (name: ThemeName): ThemeCardOption["swatch"] => {
  const tokens = PRESET_TOKENS[name];
  return { side: tokens["bg-side"], bg: tokens.bg, agent: tokens.agent };
};

const customSwatch = (theme: CustomTheme): ThemeCardOption["swatch"] => {
  const tokens = deriveTheme(theme);
  return { side: tokens["bg-side"], bg: tokens.bg, agent: tokens.agent };
};

/** Account scope: the mode and the theme of each side, as cards. The custom theme library sits below. */
export function ThemeSection() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  const preset = (name: ThemeName, tag: string): ThemeCardOption => ({
    id: name,
    name: t(`settings.appearance.preset.${name}`),
    tag,
    swatch: presetSwatch(name),
  });
  const custom = (base: "night" | "day"): ThemeCardOption[] =>
    account.customThemes
      .filter((theme) => theme.base === base)
      .map((theme) => ({
        id: theme.id,
        name: theme.name,
        tag: t("settings.theme.tag.custom"),
        swatch: customSwatch(theme),
      }));
  const dark = [
    preset("night", t("settings.theme.tag.default")),
    preset("hc", t("settings.theme.tag.a11y")),
    ...custom("night"),
  ];
  const light = [preset("day", t("settings.theme.tag.default")), ...custom("day")];
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
      <ThemeCards
        label={t("settings.appearance.darkTheme")}
        value={account.darkTheme}
        options={dark}
        onChange={(darkTheme) => setAccount({ ...account, darkTheme })}
      />
      <ThemeCards
        label={t("settings.appearance.lightTheme")}
        value={account.lightTheme}
        options={light}
        onChange={(lightTheme) => setAccount({ ...account, lightTheme })}
      />
      <CustomThemes />
    </AppearanceSection>
  );
}
