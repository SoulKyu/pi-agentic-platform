import "../../i18n/register-overview.ts";
import type { OverviewCallbacks } from "../../features/overview/callbacks.ts";
import { OverviewPane as Pane } from "../../features/overview/OverviewPane.tsx";
import { overviewActions } from "./overview-actions.tsx";

/**
 * The Overview pane, its own chunk and catalog (decision 147). The card actions (START, STOP and the stop dialog, which
 * pull in the overlays) join here, so they stay out of the initial assets; `LAZY_MARKERS` checks it.
 */
export function OverviewPane(props: Omit<OverviewCallbacks, "actions">) {
  return <Pane {...props} actions={overviewActions} />;
}
