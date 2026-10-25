import type { BoxRef, LaunchStep, LaunchView } from "@pap/contracts";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { launchOf, useLaunchStore } from "../../stores/launch-store.ts";

const loadWords = () => import("../../i18n/register-launch.ts");
let loaded = false;

/**
 * The launch words (a lazy catalog) for a part of the first paint that needs them only while something runs: fetched
 * when `active` first holds, true once registered. Until then the caller shows nothing of them, never a bare key.
 */
export function useLaunchWords(active: boolean): boolean {
  const [ready, setReady] = useState(loaded);
  useEffect(() => {
    if (!active || ready) return;
    let live = true;
    loadWords().then(
      () => {
        loaded = true;
        if (live) setReady(true);
      },
      () => undefined, // a launch is progress, never required: the plain label stays
    );
    return () => {
      live = false;
    };
  }, [active, ready]);
  return ready;
}

function useWords(step: LaunchStep | undefined): string | undefined {
  const t = useT();
  const ready = useLaunchWords(step !== undefined);
  return ready && step ? t(`launch.stage.${step}`) : undefined;
}

const runningStep = (launch: LaunchView | undefined): LaunchStep | undefined =>
  launch?.steps.find((step) => step.state === "running")?.step;

/**
 * What a button says while its box's launch runs ("Building the image…"), or undefined. The selector returns the step's
 * name, a string: a launch record that changes each second does not render the button.
 */
export function useBoxStage(box: BoxRef | null | undefined): string | undefined {
  return useWords(useLaunchStore((state) => runningStep(launchOf(state.view.launches, box))));
}

/** The same for the launch a session asked for (`for`): Send follows it. */
export function useSessionStage(sessionId: string | null | undefined): string | undefined {
  return useWords(
    useLaunchStore((state) => {
      if (!sessionId) return undefined;
      for (const launch of state.view.launches.values())
        if (launch.for === sessionId) return runningStep(launch);
      return undefined;
    }),
  );
}
