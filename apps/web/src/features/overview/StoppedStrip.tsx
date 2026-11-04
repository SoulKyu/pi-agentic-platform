import type { OverviewBox, OverviewSnapshot } from "@pap/contracts";
import { Button, Chip, Icon, IconPin } from "@pap/ui";
import { useState } from "react";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { BoxGlyph, openBox } from "./BoxCard.tsx";
import type { OverviewCallbacks } from "./callbacks.ts";
import { PHASE_TONE, nextRunLine } from "./overview.vm.ts";

interface Props {
  readonly boxes: readonly OverviewBox[];
  readonly capacity: OverviewSnapshot["capacity"];
  /** No box is active: the strip starts open, the person has nothing else to look at. */
  readonly startOpen: boolean;
  readonly now: number;
  readonly on: OverviewCallbacks;
}

/** Stopped boxes, folded to a count and their names; EXPAND lists them with what the route layer adds (START). */
export function StoppedStrip({ boxes, capacity, startOpen, now, on }: Props) {
  const t = useT();
  const locale = useLocale();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? startOpen;
  return (
    <section
      data-stopped-strip=""
      className="flex flex-col gap-s2 rounded-md border border-dashed border-border-strong p-s3"
    >
      <div className="flex flex-wrap items-center gap-s2">
        <span className="label-hud text-muted">{plural(locale, "overview.stopped.count", boxes.length)}</span>
        {open ? null : (
          <span className="min-w-0 flex-1 truncate text-ui text-muted">
            {boxes.map((box) => box.name).join(", ")}
          </span>
        )}
        <span className="ml-auto">
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setToggled(!open)}>
            {t(open ? "overview.fold" : "overview.expand")}
          </Button>
        </span>
      </div>
      {open ? (
        <ul className="flex flex-col gap-s1">
          {boxes.map((box) => (
            <li
              key={`${box.ref.kind}:${box.ref.id}`}
              data-stopped-row=""
              className="flex flex-wrap items-center gap-s2"
            >
              <BoxGlyph box={box} on={on} />
              <span className="min-w-0 flex-1">
                <Button variant="ghost" size="sm" truncate onClick={() => openBox(box, on)}>
                  {box.name}
                </Button>
              </span>
              {box.alwaysOn ? <Icon icon={IconPin} size={14} label={t("overview.alwaysOn")} /> : null}
              {box.nextRun === null ? null : (
                <span className="text-ui text-muted">{nextRunLine(box.nextRun, now, locale, t)}</span>
              )}
              {box.phase === null ? null : (
                <span data-phase="">
                  <Chip tone={PHASE_TONE[box.phase]} label={t(`overview.phase.${box.phase}`)} />
                </span>
              )}
              {on.actions?.(box, capacity)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
