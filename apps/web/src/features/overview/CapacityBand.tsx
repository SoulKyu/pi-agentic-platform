import type { MemberCapacity, OverviewSnapshot, OwnerCapacity } from "@pap/contracts";
import { Button, Meter, cn, formatCost, useIsPhone } from "@pap/ui";
import type { ReactNode } from "react";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { memoryText, percentText, sizeText } from "./overview.vm.ts";

const CELL = "flex flex-1 flex-col gap-s1 rounded-md border border-border bg-surface";

/** On a phone the three cells share one row, narrow (spec 3.7); elsewhere each keeps a pane-wide minimum and wraps. */
function Cell({ attr, children }: { readonly attr: string; readonly children: ReactNode }) {
  const phone = useIsPhone();
  return (
    <div {...{ [attr]: "" }} className={cn(CELL, phone ? "min-w-0 p-s2" : "min-w-pane p-s3")}>
      {children}
    </div>
  );
}

function Plain({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: ReactNode;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-s2">
        <span className="label-hud text-muted">{label}</span>
        <span className="font-mono text-ui tabular-nums text-fg">{value}</span>
      </div>
      {note}
    </>
  );
}

function OwnerBand({ capacity, onOpenHealth }: { readonly capacity: OwnerCapacity; onOpenHealth(): void }) {
  const t = useT();
  const locale = useLocale();
  const { memory, workers, cost, failures } = capacity;
  return (
    <>
      <Cell attr="data-band-memory">
        {memory === null ? (
          <Plain label={t("overview.band.memory")} value={t("overview.noValue")} />
        ) : (
          <>
            <Meter
              label={t("overview.band.memory")}
              value={memory.usedMb}
              max={memory.maxMb}
              kind="tokens"
              valueText={memoryText(memory.usedMb, memory.maxMb, locale, t)}
            />
            {memory.full ? (
              <span data-band-full="" className="label-hud text-fg">
                {t("overview.band.full")}
              </span>
            ) : null}
          </>
        )}
      </Cell>
      <Cell attr="data-band-workers">
        <Meter
          label={t("overview.band.workers")}
          value={workers.used}
          max={workers.max}
          kind="neutral"
          valueText={`${workers.used} / ${workers.max}`}
        />
      </Cell>
      <Cell attr="data-band-cost">
        <Plain
          label={t("overview.band.cost")}
          value={formatCost(cost.totalUsd)}
          note={
            <>
              {cost.membersUsd > 0 ? (
                <p className="text-ui text-muted">
                  {t("overview.band.membersCost", { cost: formatCost(cost.membersUsd) })}
                </p>
              ) : null}
              {cost.apiEquivalent ? (
                <p className="text-ui text-muted">{t("overview.band.apiEquivalent")}</p>
              ) : null}
            </>
          }
        />
        {failures !== null && failures > 0 ? (
          <div>
            <Button variant="ghost" size="sm" onClick={onOpenHealth}>
              {plural(locale, "overview.health", failures)}
            </Button>
          </div>
        ) : null}
      </Cell>
    </>
  );
}

function MemberBand({ capacity }: { readonly capacity: MemberCapacity }) {
  const t = useT();
  const locale = useLocale();
  const { sharedPercent, yourMb, cost } = capacity;
  return (
    <>
      <Cell attr="data-band-shared">
        {sharedPercent === null ? (
          <Plain label={t("overview.band.shared")} value={t("overview.noValue")} />
        ) : (
          <Meter
            label={t("overview.band.shared")}
            value={sharedPercent}
            max={100}
            kind="tokens"
            valueText={percentText(sharedPercent, t)}
          />
        )}
      </Cell>
      <Cell attr="data-band-yours">
        <Plain label={t("overview.band.yourBoxes")} value={sizeText(yourMb, locale, t)} />
      </Cell>
      <Cell attr="data-band-cost">
        {cost.budgetUsd === null ? (
          <Plain
            label={t("overview.band.yourCost")}
            value={formatCost(cost.usd)}
            note={<p className="text-ui text-muted">{t("overview.band.noBudget")}</p>}
          />
        ) : (
          <Meter
            label={t("overview.band.yourCost")}
            value={cost.usd}
            max={cost.budgetUsd}
            kind="cost"
            valueText={`${formatCost(cost.usd)} / ${formatCost(cost.budgetUsd)}`}
          />
        )}
      </Cell>
    </>
  );
}

/** The shared headroom, read at a glance: the owner's host figures, or a member's share of it (R3: a percentage only). */
export function CapacityBand({
  capacity,
  onOpenHealth,
}: {
  readonly capacity: OverviewSnapshot["capacity"];
  onOpenHealth(): void;
}) {
  const phone = useIsPhone();
  return (
    <div
      data-capacity-band=""
      className={cn("flex items-stretch", phone ? "flex-nowrap gap-s2" : "flex-wrap gap-s3")}
    >
      {capacity.role === "owner" ? (
        <OwnerBand capacity={capacity} onOpenHealth={onOpenHealth} />
      ) : (
        <MemberBand capacity={capacity} />
      )}
    </div>
  );
}
