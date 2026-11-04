import "../../i18n/register-launch.ts";
import type { BoxRef } from "@pap/contracts";
import { useT } from "../../i18n/index.ts";
import { useLaunchOf } from "../../stores/launch-store.ts";

/**
 * The running step of a starting box, from the launch store (features do not import each other): the step's own words,
 * nothing when the box has no live launch. The full steps panel lives on the box's own page.
 */
export function LaunchLine({ box }: { readonly box: BoxRef }) {
  const t = useT();
  const launch = useLaunchOf(box);
  if (launch === undefined) return null;
  const live = launch.steps.find((step) => step.state === "running");
  return (
    <p data-launch-strip="" role="status" className="text-ui text-muted">
      {live
        ? t(`launch.stage.${live.step}`)
        : t(box.kind === "agent" ? "launch.title.agent" : "launch.title.project")}
    </p>
  );
}
