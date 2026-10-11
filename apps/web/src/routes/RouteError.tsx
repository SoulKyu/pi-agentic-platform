import { Button, EmptyState } from "@pap/ui";
import { useEffect } from "react";
import { useT } from "../i18n/index.ts";
import { reportClientIssue } from "../lib/report.ts";

/** The screen alone: PaneBoundary reports the failure itself, so it renders this without a second report. */
export function RouteErrorScreen() {
  const t = useT();
  return (
    <EmptyState
      title={t("shell.error.title")}
      purpose={t("shell.error.purpose")}
      action={<Button onClick={() => window.location.reload()}>{t("shell.reload")}</Button>}
    />
  );
}

/** The router's error screen: translated, with a way out (M3-RT-15). Reports once per mount, never the error text. */
export function RouteError() {
  useEffect(() => reportClientIssue("render_failed"), []);
  return <RouteErrorScreen />;
}
