import { Banner, Button, toast } from "@pap/ui";
import { useT, type MessageKey } from "../../i18n/index.ts";
import type { AccountStatus } from "../../lib/account-setting.ts";
import { AppearancePreview } from "./AppearancePreview.tsx";
import { DetailsSection } from "./DetailsSection.tsx";
import { ReadingSection } from "./ReadingSection.tsx";
import { ThemeSection } from "./ThemeSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";

/** `local` says nothing: the account document knows of no saved copy. */
const STATUS_LINES: Record<AccountStatus, MessageKey | null> = {
  local: null,
  saving: "settings.appearance.status.saving",
  saved: "settings.appearance.status.saved",
  error: "settings.appearance.status.error",
  "load-error": "settings.appearance.status.loadError",
};

/** Settings › Appearance: every change applies at once; Reset covers both scopes and Undo goes back through the setters. */
export function AppearancePanel() {
  const t = useT();
  const accountStatus = useAppearanceStore((state) => state.accountStatus);
  const deviceStored = useAppearanceStore((state) => state.deviceStored);
  const resetAll = useAppearanceStore((state) => state.resetAll);
  const setAccount = useAppearanceStore((state) => state.setAccount);
  const setDevice = useAppearanceStore((state) => state.setDevice);
  const line = STATUS_LINES[accountStatus];
  const reset = () => {
    const previous = resetAll();
    toast({
      message: t("settings.appearance.resetDone"),
      action: {
        label: t("settings.appearance.undo"),
        altText: t("settings.appearance.undoAlt"),
        run: () => {
          // The reset kept the custom themes, so Undo has none to restore; themes edited since stay.
          setAccount({
            ...previous.account,
            customThemes: useAppearanceStore.getState().account.customThemes,
          });
          setDevice(previous.device);
        },
      },
    });
  };
  return (
    <div className="flex flex-col gap-s4">
      <header className="flex flex-wrap items-center justify-between gap-s2">
        <h2 className="text-h2 text-fg">{t("settings.appearance.title")}</h2>
        <Button variant="secondary" onClick={reset}>
          {t("settings.appearance.reset")}
        </Button>
      </header>
      <p role="status" data-slot="appearance-status" className="text-ui text-muted">
        {line === null ? "" : t(line)}
      </p>
      {deviceStored ? null : <Banner tone="capacity" title={t("settings.appearance.deviceNotStored")} />}
      <div className="grid gap-s6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-s6">
          <ThemeSection />
          <ReadingSection />
          <DetailsSection />
        </div>
        <div className="min-w-0">
          <AppearancePreview />
        </div>
      </div>
    </div>
  );
}
