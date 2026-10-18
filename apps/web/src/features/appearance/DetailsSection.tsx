import { Segmented, Select, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { customSlug } from "./fonts.ts";
import { FontsBlock } from "./FontsBlock.tsx";
import { useFontsStore } from "./fonts-store.ts";

const RAILS = ["left", "right"] as const;
const AVATARS = ["outlined", "tinted", "glyph"] as const;
const TOOL_DETAILS = ["compact", "expanded", "full"] as const;

/**
 * Account scope: the bundled font families, the system stacks (M3R110) or a Google font pap downloaded, labels, grid,
 * rail, avatars, tool cards.
 */
export function DetailsSection() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  const families = useFontsStore((state) => state.families);
  // The bundled choices, System, every installed family; a custom choice that is gone is shown as such once the list is known.
  const fontOptions = (bundled: { value: string; label: string }, current: string) => {
    const options = [
      bundled,
      { value: "system", label: t("settings.appearance.fontSystem") },
      ...(families ?? []).map((entry) => ({ value: `custom:${entry.slug}`, label: entry.family })),
    ];
    const gone =
      customSlug(current) !== null && families !== null && !options.some((one) => one.value === current);
    return gone
      ? [...options, { value: current, label: t("settings.appearance.fonts.removedChoice") }]
      : options;
  };
  const removed = (current: string) =>
    customSlug(current) !== null &&
    families !== null &&
    !families.some((one) => `custom:${one.slug}` === current);
  return (
    <AppearanceSection
      title={t("settings.appearance.section.details")}
      scope={t("settings.appearance.scopeAccount")}
    >
      <Select
        label={t("settings.appearance.uiFont")}
        value={account.uiFont}
        options={fontOptions(
          { value: "manrope", label: t("settings.appearance.fontManrope") },
          account.uiFont,
        )}
        {...(removed(account.uiFont) ? { hint: t("settings.appearance.fonts.removedNote") } : {})}
        onChange={(uiFont) => setAccount({ ...account, uiFont })}
      />
      <Select
        label={t("settings.appearance.monoFont")}
        value={account.monoFont}
        options={fontOptions(
          { value: "jetbrains-mono", label: t("settings.appearance.fontJetbrains") },
          account.monoFont,
        )}
        {...(removed(account.monoFont) ? { hint: t("settings.appearance.fonts.removedNote") } : {})}
        onChange={(monoFont) => setAccount({ ...account, monoFont })}
      />
      <FontsBlock />
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
