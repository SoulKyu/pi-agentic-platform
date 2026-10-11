import { Button, EmptyState } from "@pap/ui";
import { useT } from "../i18n/index.ts";

/** The router's error screen: translated, with a way out (M3-RT-15). Never shows the error itself. */
export function RouteError() {
  const t = useT();
  return (
    <EmptyState
      title={t("shell.error.title")}
      purpose={t("shell.error.purpose")}
      action={<Button onClick={() => window.location.reload()}>{t("shell.reload")}</Button>}
    />
  );
}
