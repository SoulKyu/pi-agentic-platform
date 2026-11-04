import { Segmented } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";

const OPEN_ON = ["home", "overview"] as const;

/** Settings › Appearance › Start (decision 147): which page the app's first load at "/" shows. The logo always goes Home. */
export function StartSection() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  return (
    <AppearanceSection
      title={t("settings.appearance.start.title")}
      scope={t("settings.appearance.scopeAccount")}
    >
      <Segmented
        label={t("settings.appearance.start.openOn")}
        value={account.openOn}
        options={OPEN_ON.map((value) => ({
          value,
          label: t(`settings.appearance.start.openOn.${value}`),
        }))}
        onChange={(openOn) => setAccount({ ...account, openOn })}
      />
      <p className="text-ui text-muted">{t("settings.appearance.start.hint")}</p>
    </AppearanceSection>
  );
}
