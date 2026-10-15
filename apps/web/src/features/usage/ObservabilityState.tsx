import { useT } from "../../i18n/index.ts";

/**
 * What the exports are doing, read-only (M10R121). The daemon sends two facts, never a token or a header: whether
 * `/metrics` is on and the host the OTLP export goes to.
 */
export function ObservabilityState({
  metrics,
  otlpHost,
}: {
  readonly metrics: boolean;
  readonly otlpHost: string | null;
}) {
  const t = useT();
  return (
    <ul data-observability className="flex flex-col gap-s1 text-ui text-fg">
      <li>
        {t(
          metrics
            ? "settingsAutomation.observability.metricsOn"
            : "settingsAutomation.observability.metricsOff",
        )}
      </li>
      <li>
        {otlpHost === null
          ? t("settingsAutomation.observability.otlpOff")
          : t("settingsAutomation.observability.otlpOn", { host: otlpHost })}
      </li>
      <li className="text-muted">{t("settingsAutomation.observability.trace")}</li>
    </ul>
  );
}
