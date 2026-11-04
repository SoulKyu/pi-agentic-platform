import "../../i18n/register-overview.ts";
import {
  Button,
  EmptyState,
  Heading,
  IconButton,
  IconPlus,
  InlineError,
  LoadingLine,
  useIsPhone,
} from "@pap/ui";
import { Menu } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";
import { BoxCard } from "./BoxCard.tsx";
import { CapacityBand } from "./CapacityBand.tsx";
import type { OverviewCallbacks } from "./callbacks.ts";
import { MemberLines } from "./MemberLines.tsx";
import { StoppedStrip } from "./StoppedStrip.tsx";
import { isActive } from "./overview.vm.ts";
import { useBoxesSnapshot } from "./use-boxes-snapshot.ts";

export type { OverviewCallbacks };

/**
 * The Overview (decision 147): the capacity band, the live boxes as cards in the daemon's order, the stopped ones as a
 * strip, and for the owner a line per member. Read-only: START, STOP and the rest come through `actions`.
 */
export function OverviewPane(on: OverviewCallbacks) {
  const t = useT();
  const phone = useIsPhone();
  // Times are fixed clock times (DESIGN.md 7.2: nothing repaints continuously); `now` only picks "tomorrow" for the next run and moves with each read.
  const { snapshot, failed, readAt: now, reload } = useBoxesSnapshot();

  let body;
  if (snapshot === null) {
    body = failed ? (
      <div className="flex flex-col items-start gap-s2">
        <InlineError announce="background">{t("overview.failed")}</InlineError>
        <Button variant="secondary" onClick={reload}>
          {t("overview.retry")}
        </Button>
      </div>
    ) : (
      <LoadingLine label={t("overview.loading")} />
    );
  } else {
    const active = snapshot.boxes.filter(isActive);
    const stopped = snapshot.boxes.filter((box) => !isActive(box));
    const owner = snapshot.capacity.role === "owner";
    body = (
      <>
        {failed ? <InlineError announce="background">{t("overview.stale")}</InlineError> : null}
        <CapacityBand capacity={snapshot.capacity} onOpenHealth={on.openHealth} />
        {snapshot.vmUsable ? null : (
          <EmptyState
            level={3}
            title={t("overview.noVm.title")}
            purpose={t("overview.noVm.purpose")}
            action={
              <Button variant="secondary" onClick={reload}>
                {t("overview.checkAgain")}
              </Button>
            }
          />
        )}
        {snapshot.boxes.length === 0 && snapshot.vmUsable ? (
          <EmptyState
            level={3}
            title={t("overview.title")}
            purpose={t("overview.empty.purpose")}
            action={
              <div className="flex flex-wrap items-center gap-s2">
                <Button variant="primary" onClick={on.newProject}>
                  {t("overview.newProject")}
                </Button>
                <Button variant="secondary" onClick={on.newAgent}>
                  {t("overview.newAgent")}
                </Button>
              </div>
            }
          />
        ) : null}
        {owner && snapshot.boxes.length > 0 ? (
          <Heading level={3} variant="group">
            {t("overview.group.you")}
          </Heading>
        ) : null}
        {active.length > 0 ? (
          <div className={phone ? "flex flex-col gap-s3" : "flex flex-wrap items-start gap-s3"}>
            {active.map((box) => (
              <BoxCard
                key={`${box.ref.kind}:${box.ref.id}`}
                box={box}
                capacity={snapshot.capacity}
                now={now}
                on={on}
              />
            ))}
          </div>
        ) : stopped.length > 0 ? (
          <p className="text-ui text-muted">{t("overview.empty.idle")}</p>
        ) : null}
        {stopped.length > 0 ? (
          <StoppedStrip
            boxes={stopped}
            capacity={snapshot.capacity}
            startOpen={active.length === 0}
            now={now}
            on={on}
          />
        ) : null}
        {owner && snapshot.members.length > 0 ? <MemberLines members={snapshot.members} /> : null}
      </>
    );
  }

  return (
    <section data-overview-pane="" className="flex min-h-0 flex-1 flex-col gap-s3 overflow-y-auto p-s3">
      <div className="flex items-center justify-between gap-s2">
        <Heading level={2} variant="section">
          {t("overview.title")}
        </Heading>
        <Menu
          label={t("overview.new")}
          closeLabel={t("ui.close")}
          trigger={<IconButton icon={IconPlus} label={t("overview.new")} />}
          items={[
            { id: "agent", label: t("overview.newAgent"), onSelect: on.newAgent },
            { id: "project", label: t("overview.newProject"), onSelect: on.newProject },
          ]}
        />
      </div>
      {body}
    </section>
  );
}
