import type { ProjectSummary, ToolPreset } from "@pap/contracts";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { notifyLazyFailure } from "../../lib/lazy.tsx";
import type { HomeActions } from "./home-actions.ts";
import type { HomeMode } from "./home-mode.ts";

// What each mode does, and the words of its errors, are a chunk of their own: fetched on the first Launch.
const loadRun = () => import("./run-launch.ts");

/** Launch (§3.1): busy while the chunk loads and the launch runs; the error it ends with, if any. */
export function useLaunch(actions: HomeActions, preset: ToolPreset, projectId: string | null) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The line speaks of the last launch: another project in the chip is another start.
  const [seenProject, setSeenProject] = useState(projectId);
  if (seenProject !== projectId) {
    setSeenProject(projectId);
    setError(null);
  }
  const launch = (mode: HomeMode, project: ProjectSummary, text: string): void => {
    setError(null);
    setBusy(true);
    // Promise chains, not try/finally: the React Compiler bails out on a finalizer.
    loadRun()
      .then(
        (run) =>
          run.runLaunch(actions, preset, mode, project, text).then((failure) => {
            setBusy(false);
            setError(failure);
          }),
        (failure: unknown) => {
          setBusy(false);
          notifyLazyFailure(failure, lazyText);
        },
      )
      // A hand-off or an `open` that throws: Launch is usable again and the person is told.
      .catch(() => {
        setBusy(false);
        setError(t("error.internal"));
      });
  };
  return { launch, busy, error };
}
