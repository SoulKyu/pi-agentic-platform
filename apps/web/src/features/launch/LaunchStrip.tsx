import "../../i18n/register-launch.ts";
import type { BoxRef, LaunchView } from "@pap/contracts";
import { useT } from "../../i18n/index.ts";
import { useLaunchOf } from "../../stores/launch-store.ts";
import { Segments } from "./LaunchSegments.tsx";

/**
 * One line and five segments for a box that is starting: the running step's words (the button's own stage words), then a
 * segment per step. Nothing when the box has no live launch, or when `only` refuses it (a task card shows the launch that
 * is its own). Colour is role: done, running and failed only.
 */
export function LaunchStrip({
  box,
  only,
}: {
  readonly box: BoxRef | null;
  readonly only?: ((launch: LaunchView) => boolean) | undefined;
}) {
  const t = useT();
  const launch = useLaunchOf(box);
  if (launch === undefined || (only !== undefined && !only(launch))) return null;
  const live = launch.steps.find((step) => step.state === "running");
  return (
    <div data-launch-strip="" role="status" className="flex flex-col gap-s1">
      <p className="text-ui text-muted">
        {live ? t(`launch.stage.${live.step}`) : t("launch.title.project")}
      </p>
      <Segments launch={launch} />
    </div>
  );
}
