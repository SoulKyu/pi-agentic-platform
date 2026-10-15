import {
  isProviderUsageId,
  type ModelsUsageResult,
  type UsageBucket,
  type UsageReport,
} from "@pap/contracts";
import { Button, Meter } from "@pap/ui";
import { useState } from "react";
import { modelsUsageEn, modelsUsageFr } from "../../i18n/catalog/models-usage.ts";
import { registerCatalog, type Translate, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";

registerCatalog({ en: modelsUsageEn, fr: modelsUsageFr });

type Outcome =
  | { readonly kind: "answer"; readonly answer: ModelsUsageResult }
  | { readonly kind: "error"; readonly text: string };

const amount = (value: number): string => String(Number(value.toFixed(2)));
const withUnit = (value: number, unit: UsageBucket["unit"], currency: string | undefined): string =>
  unit === "percent" ? `${amount(value)}%` : currency ? `${amount(value)} ${currency}` : amount(value);

function BucketRow({
  bucket,
  locale,
  t,
}: {
  readonly bucket: UsageBucket;
  readonly locale: string;
  readonly t: Translate;
}) {
  const { limit, used, remaining, unit, currency } = bucket;
  const spent =
    used ?? (limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined);
  const resets =
    bucket.resetsAt === undefined
      ? null
      : t("modelsUsage.resets", {
          time: new Date(bucket.resetsAt * 1000).toLocaleString(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        });
  const extra = [bucket.period, resets].filter((part): part is string => part !== undefined && part !== null);
  return (
    <li className="flex flex-col gap-s1">
      {limit !== undefined && limit > 0 && spent !== undefined ? (
        <Meter
          label={bucket.label}
          value={spent}
          max={limit}
          kind={unit === "currency" ? "cost" : "tokens"}
          valueText={
            unit === "percent"
              ? t("modelsUsage.percentUsed", { used: amount(spent) })
              : t("modelsUsage.of", { used: amount(spent), limit: withUnit(limit, unit, currency) })
          }
        />
      ) : (
        <div className="flex items-baseline justify-between gap-s2">
          <span className="label-hud text-muted">{bucket.label}</span>
          <span className="font-mono text-ui tabular-nums text-fg">
            {remaining !== undefined
              ? t("modelsUsage.left", { amount: withUnit(remaining, unit, currency) })
              : spent !== undefined
                ? t("modelsUsage.used", { amount: withUnit(spent, unit, currency) })
                : ""}
          </span>
        </div>
      )}
      {extra.length > 0 ? <p className="text-ui text-muted">{extra.join(" · ")}</p> : null}
    </li>
  );
}

function ReportView({
  report,
  locale,
  t,
}: {
  readonly report: UsageReport;
  readonly locale: string;
  readonly t: Translate;
}) {
  return (
    <div className="flex flex-col gap-s2">
      {report.buckets.length > 0 ? (
        <ul className="flex flex-col gap-s2">
          {report.buckets.map((bucket) => (
            <BucketRow key={bucket.id} bucket={bucket} locale={locale} t={t} />
          ))}
        </ul>
      ) : null}
      {report.metrics.length > 0 ? (
        <ul className="flex flex-col gap-s1">
          {report.metrics.map((metric) => (
            <li key={metric.id} className="flex items-baseline justify-between gap-s2">
              <span className="text-ui text-muted">{metric.label}</span>
              <span className="font-mono text-ui tabular-nums text-fg">
                {typeof metric.value === "number" ? amount(metric.value) : metric.value}
                {metric.currency ? ` ${metric.currency}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-ui text-muted">
        {t("modelsUsage.checkedAt", {
          time: new Date(report.capturedAt).toLocaleString(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
      </p>
    </div>
  );
}

const FAILURE_KEYS = {
  auth_unavailable: "modelsUsage.auth",
  query_failed: "modelsUsage.failed",
  provider_overridden: "modelsUsage.overridden",
  extensions_failed: "modelsUsage.extensionsFailed",
  unsupported: "modelsUsage.unsupported",
} as const;

/**
 * A provider's usage quotas: one button, and nothing is asked until it is clicked. The daemon runs the query in the
 * helper (the key never reaches this page) and keeps the answer for a minute. Provider text is shown as plain text.
 */
export function ProviderUsage({ providerId }: { readonly providerId: string }) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  if (!isProviderUsageId(providerId)) return null;

  const check = () => {
    if (busy) return;
    setBusy(true);
    getRuntime()
      .rpc.call("models.usage", { providerId })
      .then(
        (answer) => setOutcome({ kind: "answer", answer }),
        (failure: unknown) => setOutcome({ kind: "error", text: failureText(failure) }),
      )
      .finally(() => setBusy(false));
  };

  const answer = outcome?.kind === "answer" ? outcome.answer : null;
  return (
    <section aria-label={t("modelsUsage.title")} className="flex flex-col gap-s2">
      <h3 className="label-hud text-muted">{t("modelsUsage.title")}</h3>
      <p className="text-ui text-muted">{t("modelsUsage.note")}</p>
      <div>
        <Button disabled={busy} onClick={check}>
          {t("modelsUsage.check")}
        </Button>
      </div>
      {answer?.status === "ready" ? <ReportView report={answer.report} locale={locale} t={t} /> : null}
      {answer !== null && answer.status !== "ready" ? (
        <p role="alert" className="text-ui text-attn">
          {t(FAILURE_KEYS[answer.status])}
        </p>
      ) : null}
      {outcome?.kind === "error" ? (
        <p role="alert" className="text-ui text-attn">
          {outcome.text}
        </p>
      ) : null}
    </section>
  );
}
