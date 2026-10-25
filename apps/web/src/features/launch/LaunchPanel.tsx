import type { BoxRef } from "@pap/contracts";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { useLaunchOf } from "../../stores/launch-store.ts";

const loadPanel = () => import("./StepPanel.tsx");
const ignore = () => undefined;

/**
 * The step panel of a box's live launch, or nothing: the panel and its words are a chunk of their own, fetched on the
 * first launch, so the first paint carries none of it. An ended launch is gone from the store and leaves no panel behind;
 * a failed one leaves the InlineError of the screen that asked.
 */
export function LaunchPanel({
  box,
  onWaitingAction,
}: {
  readonly box: BoxRef | null;
  onWaitingAction?: (() => void) | undefined;
}) {
  const launch = useLaunchOf(box);
  const text = useLazyFailureText();
  if (launch === undefined) return null;
  return (
    <LazyPanel text={text} load={loadPanel} open props={{ launch, onWaitingAction }} onFailed={ignore} />
  );
}
