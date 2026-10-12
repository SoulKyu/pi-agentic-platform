import { Banner, Button } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";

export function ConnectionBanner() {
  const t = useT();
  const connection = useConnectionState(getRuntime().connection);
  if (connection === "waiting") {
    return (
      <Banner tone="offline" title={t("connection.reconnecting")}>
        {t("connection.draftsStay")}
      </Banner>
    );
  }
  if (connection === "outdated") {
    return (
      <Banner
        tone="capacity"
        title={t("connection.outdated")}
        actions={<Button onClick={() => window.location.reload()}>{t("shell.reload")}</Button>}
      />
    );
  }
  return null;
}
