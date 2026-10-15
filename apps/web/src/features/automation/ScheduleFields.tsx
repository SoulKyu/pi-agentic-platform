import { Button, Select, Switch, TextField } from "@pap/ui";
import { useMemo } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import type { SectionProps } from "./EditorSection.tsx";
import { RRULE_PRESETS, rrulePreview, zoneOptions } from "./editor.vm.ts";

const PRESETS = ["hourly", "daily", "weekdays", "weekly"] as const;

/** The RRULE with its presets, the zone, catch-up, and the next five fires in that zone (a refusal shows the contract's reason). */
export function ScheduleFields({ draft, set, now }: SectionProps & { readonly now: number }) {
  const t = useT();
  const locale = useLocale();
  const preview = useMemo(
    () => rrulePreview(draft.rrule, draft.timezone, now),
    [draft.rrule, draft.timezone, now],
  );
  const zones = useMemo(() => zoneOptions(draft.timezone), [draft.timezone]);
  const format = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: draft.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(at);

  return (
    <>
      <div
        role="group"
        aria-label={t("automation.editor.schedule.presets")}
        className="flex flex-wrap gap-s2"
      >
        {PRESETS.map((preset) => (
          <Button key={preset} size="sm" onClick={() => set({ rrule: RRULE_PRESETS[preset] })}>
            {t(`automation.editor.schedule.${preset}`)}
          </Button>
        ))}
      </div>
      <TextField
        label={t("automation.editor.schedule.rrule")}
        value={draft.rrule}
        error={
          preview.ok
            ? null
            : [
                t("automation.editor.schedule.refused", { reason: preview.message }),
                preview.missing === null ? "" : t("automation.editor.schedule.needsByhour"),
              ]
                .join(" ")
                .trim()
        }
        onChange={(rrule) => set({ rrule })}
      />
      <Select
        label={t("automation.editor.schedule.timezone")}
        value={draft.timezone}
        options={zones.map((zone) => ({ value: zone, label: zone }))}
        onChange={(timezone) => set({ timezone })}
      />
      <Switch
        label={t("automation.editor.schedule.catchUp")}
        checked={draft.catchUp === "once"}
        onChange={(on) => set({ catchUp: on ? "once" : "skip" })}
      />
      {preview.ok ? (
        <div className="flex flex-col gap-s1">
          <p className="label-hud text-muted">
            {t("automation.editor.schedule.next", { zone: draft.timezone })}
          </p>
          {preview.times.length === 0 ? (
            <p className="text-ui text-muted">{t("automation.editor.schedule.none")}</p>
          ) : (
            <ol data-slot="next-fires" className="flex flex-col gap-s1 font-mono text-code tabular-nums">
              {preview.times.map((at) => (
                <li key={at}>{format(at)}</li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </>
  );
}
