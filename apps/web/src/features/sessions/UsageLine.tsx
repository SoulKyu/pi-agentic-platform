import "../../i18n/register-reply-tools.ts";
import { formatCost } from "@pap/ui";
import { useLocale, useT } from "../../i18n/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { costLineOf, meterOf } from "./usage.vm.ts";

/** The context meter and the cost of the session, at the end of the model bar's row (UX-1 §4.4). Nothing renders without a figure. */
export function UsageLine({ view }: { readonly view: SessionView }) {
  const t = useT();
  const locale = useLocale();
  const meter = meterOf(view);
  const line = costLineOf(view);
  if (!meter && !line) return null;
  const tokens = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const cost = line
    ? [
        t("reply.meter.session", { cost: formatCost(line.session) }),
        ...(line.run === null ? [] : [t("reply.meter.run", { cost: formatCost(line.run) })]),
        ...(line.apiEquivalent ? [t("reply.meter.apiEquivalent")] : []),
      ].join(" · ")
    : null;
  const valueText = meter
    ? t("reply.meter.context", { used: tokens.format(meter.used), window: tokens.format(meter.window) })
    : "";
  return (
    <div
      data-usage-line
      className="flex flex-wrap items-center gap-x-s3 gap-y-s1 font-mono text-ui text-muted"
    >
      {meter ? (
        <div className="flex items-center gap-s2">
          <div
            role="meter"
            aria-label={t("reply.meter.label")}
            aria-valuemin={0}
            aria-valuemax={meter.window}
            aria-valuenow={Math.min(meter.used, meter.window)}
            aria-valuetext={valueText}
            className="h-1 w-16 bg-surface-2"
          >
            <div
              className={meter.soon ? "h-full bg-attn-fill" : "h-full bg-agent-fill"}
              style={{ width: `${Math.min(100, (meter.used / meter.window) * 100)}%` }}
            />
          </div>
          <span className="tabular-nums">{valueText}</span>
          {meter.soon ? <span className="text-attn">{t("reply.meter.soon")}</span> : null}
        </div>
      ) : null}
      {cost ? <span className="tabular-nums">{cost}</span> : null}
    </div>
  );
}
