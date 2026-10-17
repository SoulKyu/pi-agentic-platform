import { Segmented } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";

const EVENT_CARDS = ["cards", "compact"] as const;
const STATUS_PANEL = ["shown", "hidden"] as const;

/** Settings › Appearance › Agents (M11R98): how an agent thread draws its event cards, and whether the status panel shows. */
export function AgentsSection() {
  const t = useT();
  const account = useAppearanceStore((state) => state.account);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  return (
    <AppearanceSection
      title={t("settings.appearance.agents.title")}
      scope={t("settings.appearance.scopeAccount")}
    >
      <Segmented
        label={t("settings.appearance.agents.eventCards")}
        value={account.eventCards}
        options={EVENT_CARDS.map((value) => ({
          value,
          label: t(`settings.appearance.agents.eventCards.${value}`),
        }))}
        onChange={(eventCards) => setAccount({ ...account, eventCards })}
      />
      <p className="text-ui text-muted">{t("settings.appearance.agents.eventCards.hint")}</p>
      <Segmented
        label={t("settings.appearance.agents.statusPanel")}
        value={account.statusPanel}
        options={STATUS_PANEL.map((value) => ({
          value,
          label: t(`settings.appearance.agents.statusPanel.${value}`),
        }))}
        onChange={(statusPanel) => setAccount({ ...account, statusPanel })}
      />
      <p className="text-ui text-muted">{t("settings.appearance.agents.statusPanel.hint")}</p>
    </AppearanceSection>
  );
}
