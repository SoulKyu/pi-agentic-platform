import type { UsageRange, UsageSummary } from "@pap/contracts";
import { Heading, InlineError, Meter, Segmented } from "@pap/ui";
import type { ReactNode } from "react";
import { type MessageKey, useLocale, useT } from "../../i18n/index.ts";
import {
  billingLabelKey,
  formatTokens,
  formatUsd,
  meterFraction,
  orderedOrigins,
  originLabelKey,
  SPENDING_RANGES,
} from "./spending.vm.ts";

const CELL = "px-s2 py-s1 text-left";
const NUMBER_CELL = "px-s2 py-s1 text-right font-mono tabular-nums";

/**
 * What the owner spent (board 09's status panel, M10R121). The meter counts the automatic runs of today, which is what
 * the daily budget counts; the table and the totals count every run in the range, the owner's own sessions included.
 */
export function SpendingPanel({
  summary,
  failed,
  range,
  onRange,
  spend,
  quotasLink,
}: {
  readonly summary: UsageSummary | null;
  readonly failed: boolean;
  readonly range: UsageRange;
  onRange(range: UsageRange): void;
  /** Today's automatic spend and the daily budget, from the `usage` stream; null until its snapshot came. */
  readonly spend: { readonly todayUsd: number; readonly budgetUsd: number | null } | null;
  /** The link to Settings › Models, where the provider quotas live. */
  readonly quotasLink: ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const rangeLabel = (value: UsageRange) => t(`settingsAutomation.range.${value}` satisfies MessageKey);
  const fraction = spend === null ? null : meterFraction(spend.todayUsd, spend.budgetUsd);
  const spent = formatUsd(spend?.todayUsd ?? 0, locale);
  return (
    <div data-spending className="flex flex-col gap-s3">
      <div className="flex flex-col gap-s1">
        {spend === null ? null : fraction === null || spend.budgetUsd === null ? (
          <p className="text-ui text-fg">
            <span className="label-hud text-muted">{t("settingsAutomation.meter.label")}</span>{" "}
            <span className="font-mono tabular-nums">
              {t("settingsAutomation.meter.noBudget", { spent })}
            </span>
          </p>
        ) : (
          <Meter
            label={t("settingsAutomation.meter.label")}
            kind="cost"
            value={fraction}
            max={1}
            valueText={t("settingsAutomation.meter.of", {
              spent,
              budget: formatUsd(spend.budgetUsd, locale),
            })}
          />
        )}
        <p className="text-ui text-pretty text-muted">{t("settingsAutomation.meter.note")}</p>
      </div>
      <Segmented
        label={t("settingsAutomation.spending.range")}
        value={range}
        options={SPENDING_RANGES.map((value) => ({ value, label: rangeLabel(value) }))}
        onChange={onRange}
      />
      {failed ? (
        <InlineError announce="background">{t("settingsAutomation.spending.failed")}</InlineError>
      ) : null}
      {summary === null ? null : (
        <>
          <div className="flex flex-col gap-s1">
            <span className="label-hud text-muted">
              {t("settingsAutomation.total.label", { range: rangeLabel(range) })}
            </span>
            <span className="font-mono text-ui tabular-nums text-fg">
              {t("settingsAutomation.total.value", {
                cost: formatUsd(summary.totals.costUsd, locale),
                tokens: formatTokens(summary.totals.tokens, locale),
                runs: formatTokens(summary.totals.runs, locale),
              })}
            </span>
            <span className="text-ui text-muted">{t("settingsAutomation.total.note")}</span>
          </div>
          <Heading level={3} variant="group">
            {t("settingsAutomation.models.title")}
          </Heading>
          {summary.byModel.length === 0 ? (
            <p className="text-ui text-muted">{t("settingsAutomation.models.empty")}</p>
          ) : (
            <table data-table="models" className="w-full text-ui text-fg">
              <thead>
                <tr className="label-hud text-muted">
                  <th className={CELL}>{t("settingsAutomation.models.model")}</th>
                  <th className={NUMBER_CELL}>{t("settingsAutomation.models.tokens")}</th>
                  <th className={NUMBER_CELL}>{t("settingsAutomation.models.runs")}</th>
                  <th className={NUMBER_CELL}>{t("settingsAutomation.models.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {summary.byModel.map((row) => {
                  const billing = billingLabelKey(row.billing);
                  return (
                    <tr
                      key={`${row.provider}/${row.model}/${row.billing}`}
                      className="border-t border-border"
                    >
                      <th
                        scope="row"
                        className={`${CELL} font-normal`}
                      >{`${row.provider} / ${row.model}`}</th>
                      <td className={NUMBER_CELL}>{formatTokens(row.tokens, locale)}</td>
                      <td className={NUMBER_CELL}>{formatTokens(row.runs, locale)}</td>
                      <td className={NUMBER_CELL}>
                        {formatUsd(row.costUsd, locale)}
                        {billing === null ? null : <span className="text-muted"> {t(billing)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <Heading level={3} variant="group">
            {t("settingsAutomation.origin.title")}
          </Heading>
          <table data-table="origins" className="w-full text-ui text-fg">
            <tbody>
              {orderedOrigins(summary.byOrigin).map((row) => {
                const key = originLabelKey(row.origin);
                return (
                  <tr key={row.origin} className="border-t border-border">
                    <th scope="row" className={`${CELL} font-normal`}>
                      {key === null ? row.origin : t(key)}
                    </th>
                    <td className={NUMBER_CELL}>{formatTokens(row.tokens, locale)}</td>
                    <td className={NUMBER_CELL}>{formatTokens(row.runs, locale)}</td>
                    <td className={NUMBER_CELL}>{formatUsd(row.costUsd, locale)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <p className="text-ui text-pretty text-muted">
        {t("settingsAutomation.spending.quotas")} {quotasLink}
      </p>
    </div>
  );
}
