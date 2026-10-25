import type { BoxRef, LaunchStepState, LaunchView } from "@pap/contracts";
import { cn } from "@pap/ui";
import { useLaunchOf } from "../../stores/launch-store.ts";

/** The box steps; the worker step belongs to a session, not to the box. */
const BOX_STEPS = 5;

const SEGMENT: Readonly<Record<LaunchStepState, string>> = {
  pending: "bg-border",
  skipped: "bg-border-strong",
  running: "bg-agent",
  done: "bg-ok",
  failed: "bg-err",
};

export function Segments({ launch, compact }: { readonly launch: LaunchView; readonly compact?: boolean }) {
  return (
    <div aria-hidden data-launch-segments="" className={cn("flex gap-s1", compact ? "w-full" : null)}>
      {launch.steps.slice(0, BOX_STEPS).map((step) => (
        <span
          key={step.step}
          data-segment={step.step}
          data-state={step.state}
          className={cn("h-s1 flex-1 rounded-sm", SEGMENT[step.state])}
        />
      ))}
    </div>
  );
}

/** Five segments and no words, for the rail's avatar: no catalog, nothing to say aloud (the avatar is `aria-busy`). */
export function LaunchSegments({ box }: { readonly box: BoxRef | null }) {
  const launch = useLaunchOf(box);
  return launch === undefined ? null : <Segments launch={launch} compact />;
}
