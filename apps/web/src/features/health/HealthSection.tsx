import "../../i18n/register-health.ts";
import type { HealthEvent } from "@pap/contracts";
import { Button, Chip, EmptyState, Segmented, TextField, InlineError } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedOps } from "../../stores/health-feed.ts";
import { useHealthStore } from "../../stores/health-store.ts";
import { keeps, loadFilters, saveFilters, withSeverity, type HealthFilters } from "./health-filters.ts";
import { codeText, cursorOf, sourceOf, whenText } from "./health.vm.ts";

const KINDS = ["all", "feed", "sched", "task", "outbox", "agent"] as const;
const SEVERITIES = ["err", "att", "mut"] as const;

/**
 * Settings › Health (spec §5): the daemon's failure console of the current run. One row per collapsed event,
 * newest first, fed by the `ops` stream only — no timer, no polling; the subscription tick is the sole repaint.
 */
export function HealthSection() {
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const view = useHealthStore((state) => state.view);
  const [failed, setFailed] = useState(false);
  const [now] = useState(() => Date.now());
  const [filters, setFilters] = useState<HealthFilters>(loadFilters);
  const update = (next: HealthFilters) => {
    setFilters(next);
    saveFilters(next);
  };

  useEffect(() => feedOps(getRuntime().subscriptions, () => setFailed(true)), []);

  // A polite live region says an `err` event that arrives, once; the snapshot's own top and a refresh that changes
  // nothing stay silent. Adjusting state while rendering, not in an effect (the InboxButton pattern).
  const top = view.loaded ? (view.events[0] ?? null) : null;
  const level = view.loaded ? (view.events[0]?.seq ?? 0) : null;
  const [seen, setSeen] = useState<number | null>(null);
  const [arrived, setArrived] = useState<HealthEvent | null>(null);
  if (seen !== level) {
    setSeen(level);
    setArrived(seen !== null && top !== null && top.seq > seen && top.severity === "err" ? top : null);
  }
  const announce = arrived === null ? "" : t("health.announce", { code: arrived.code });

  const more = () => {
    const before = cursorOf(view.events);
    if (before === undefined) return;
    getRuntime()
      .rpc.call("ops.events.list", { before })
      .then(
        (page) => useHealthStore.getState().append(page),
        () => setFailed(true),
      );
  };

  const retry = () => {
    getRuntime().subscriptions.resync("ops", "me");
    setFailed(false);
  };

  return (
    <div data-health-section className="flex flex-col gap-s3">
      <h2 className="sr-only">{t("health.title")}</h2>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      {failed ? (
        <div className="flex flex-wrap items-center gap-s2">
          <InlineError announce="background">{t("health.failed")}</InlineError>
          <Button onClick={retry}>{t("health.retry")}</Button>
        </div>
      ) : null}
      {!failed && view.loaded && view.events.length === 0 ? (
        <EmptyState
          title={t("health.empty.title")}
          purpose={t("health.empty.purpose")}
          action={
            <Button
              onClick={() => navigate({ to: "/tasks" }).catch(() => reportClientIssue("command_failed"))}
            >
              {t("health.empty.action")}
            </Button>
          }
        />
      ) : null}
      {!failed && view.loaded && view.events.length > 0 ? (
        <div className="flex flex-wrap items-end gap-s3" data-health-filters>
          <Segmented
            label={t("health.filter.label")}
            value={filters.kind}
            options={KINDS.map((kind) => ({ value: kind, label: t(`health.filter.${kind}`) }))}
            onChange={(kind) => update({ ...filters, kind })}
          />
          {SEVERITIES.map((severity) => {
            const on = filters.severities[severity];
            return (
              <button
                key={severity}
                type="button"
                aria-pressed={on}
                aria-label={t(`health.severity.${severity}`)}
                onClick={() => update(withSeverity(filters, severity, !on))}
              >
                <Chip tone={on ? severity : "mut"} label={t(`health.severity.${severity}`)} />
              </button>
            );
          })}
          <div className="w-48">
            <TextField
              label={t("health.search.label")}
              value={filters.search}
              onChange={(search) => update({ ...filters, search })}
            />
          </div>
        </div>
      ) : null}
      {!failed && view.loaded && view.events.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-ui">
            <thead>
              <tr className="border-b border-border text-left">
                {(["when", "severity", "kind", "code", "detail", "source", "count"] as const).map(
                  (column) => (
                    <th key={column} scope="col" className="label-hud px-s3 py-s1 text-muted">
                      {t(`health.column.${column}`)}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {view.events
                .filter((event) => keeps(event, filters))
                .map((event) => {
                  const source = sourceOf(event);
                  return (
                    <tr key={event.seq} className="border-b border-border align-top">
                      <td className="whitespace-nowrap px-s3 py-s1 font-mono text-code text-muted tabular-nums">
                        {whenText(event.ts, now, locale)}
                      </td>
                      <td className="px-s3 py-s1">
                        <Chip tone={event.severity} label={t(`health.severity.${event.severity}`)} />
                      </td>
                      <td className="whitespace-nowrap px-s3 py-s1 label-hud text-muted">
                        {t(`health.kind.${event.kind}`)}
                      </td>
                      <td className="whitespace-nowrap px-s3 py-s1 font-mono text-code text-fg">
                        {event.code}
                      </td>
                      <td className="min-w-0 break-words px-s3 py-s1 text-fg">{codeText(event)}</td>
                      <td className="px-s3 py-s1 font-mono text-code text-muted">
                        {source.to === null ? (
                          source.label
                        ) : source.to === "/tasks" ? (
                          <Link to={source.to} className="text-fg underline focus-ring">
                            {source.label}
                          </Link>
                        ) : (
                          <Link
                            to={source.to}
                            params={source.params}
                            className="text-fg underline focus-ring"
                          >
                            {source.label}
                          </Link>
                        )}
                      </td>
                      <td className="px-s3 py-s1 font-mono text-code text-muted tabular-nums">
                        {event.count > 1 ? t("health.count", { n: event.count }) : "—"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : null}
      {!failed && view.loaded && view.hasMore && view.events.length > 0 ? (
        <div>
          <Button onClick={more}>{t("health.more")}</Button>
        </div>
      ) : null}
    </div>
  );
}
