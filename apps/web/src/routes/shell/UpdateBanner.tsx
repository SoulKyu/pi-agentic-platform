import { Banner, Button, toast } from "@pap/ui";
import { useState } from "react";
import "../../i18n/register-pwa.ts";
import "../../i18n/register-push.ts";
import { useT } from "../../i18n/index.ts";
import { applyUpdate } from "../../features/pwa/index.ts";
import { enableFailureKey } from "../../features/notifications/messages.ts";
import { getRuntime, windowTimers } from "../../runtime/index.ts";
import { bannerKind, usePwa } from "../../stores/pwa.ts";

/**
 * One tap on a device whose subscription must be made again. The permission is already granted (that is the only case
 * where the key is compared), so no prompt needs the gesture; the push code loads here, on the tap.
 */
async function reenable(t: ReturnType<typeof useT>): Promise<void> {
  try {
    const { enableThisDevice } = await import("../../features/notifications/start.ts");
    const result = await enableThisDevice(getRuntime().rpc, windowTimers);
    if (!result.ok) toast({ message: t(enableFailureKey(result.reason)), tone: "error" });
  } catch {
    toast({ message: t("push.enable.failed"), tone: "error" });
  }
}

/** The page (web shell) has an update, the device must be re-enabled, or its worker could not install. Lazy. */
export default function UpdateBanner() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const hideReenable = usePwa((state) => state.hideReenable);
  const kind = usePwa((state) => bannerKind(state));
  const hideUpdate = usePwa((state) => state.hideUpdate);
  const hideFailed = usePwa((state) => state.hideFailed);
  if (!kind) return null;
  // Fixed below the notch (iOS standalone): `styles.css` adds the safe-area inset to its top offset.
  const onReenable = () => {
    if (busy) return;
    setBusy(true);
    void reenable(t).finally(() => setBusy(false));
  };
  return (
    <div data-update-banner className="fixed inset-x-s2 z-40 md:mx-auto md:max-w-xl">
      {kind === "update" ? (
        <Banner
          tone="checkpoint"
          title={t("pwa.update.title")}
          actions={
            <>
              <Button onClick={hideUpdate}>{t("pwa.update.later")}</Button>
              <Button variant="primary" onClick={applyUpdate}>
                {t("pwa.update.reload")}
              </Button>
            </>
          }
        >
          {t("pwa.update.body")}
        </Banner>
      ) : kind === "reenable" ? (
        <Banner
          tone="checkpoint"
          title={t("push.reenable.title")}
          actions={
            <>
              <Button onClick={hideReenable}>{t("push.reenable.later")}</Button>
              <Button variant="primary" disabled={busy} onClick={onReenable}>
                {t("push.reenable.action")}
              </Button>
            </>
          }
        >
          {t("push.reenable.body")}
        </Banner>
      ) : (
        <Banner
          tone="capacity"
          title={t("pwa.failed.title")}
          actions={<Button onClick={hideFailed}>{t("pwa.hide")}</Button>}
        >
          {t("pwa.failed.body")}
        </Banner>
      )}
    </div>
  );
}
