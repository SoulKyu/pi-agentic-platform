import { HOME_PARTS } from "@pap/contracts";
import { Checkbox } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";

/** Settings › Appearance › Home (decision 85, §6): which parts of the project home show; same document, same sync. */
export function HomeSection() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  return (
    <AppearanceSection
      title={t("settings.appearance.section.home")}
      scope={t("settings.appearance.scopeAccount")}
    >
      <p className="text-ui text-muted">{t("settings.appearance.home.intro")}</p>
      {HOME_PARTS.map((part) => (
        <Checkbox
          key={part}
          label={t(`settings.appearance.home.${part}`)}
          checked={account.home[part]}
          onChange={(shown) => setAccount({ ...account, home: { ...account.home, [part]: shown } })}
        />
      ))}
    </AppearanceSection>
  );
}
