import { Button, LoadingLine } from "@pap/ui";
import { useState } from "react";
import type { ModelsPanel } from "../../features/auth/PiStep.tsx";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import "../../i18n/register-launch.ts";
import { usePiCauseText } from "../../stores/loading-cause.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadModels = () =>
  import("../../features/models/ModelsSection.tsx").then((module) => ({ default: module.ModelsSection }));

/**
 * The providers panel of Settings › Models (Task 13) inside the Pi step, in its own chunk (M7R126). This host hands it
 * the step-up runner of the setup flow, so the models feature does not import the auth feature.
 */
export const SetupModels: ModelsPanel = ({ stepUp }) => {
  const t = useT();
  const cause = usePiCauseText(t);
  const failureText = useLazyFailureText();
  const { Lazy, attempt, retry } = useRetryableLazy(loadModels);
  const [failed, setFailed] = useState(false);
  return (
    <LazyBoundary
      resetKey={attempt}
      onError={(error) => {
        setFailed(true);
        notifyLazyFailure(error, failureText);
      }}
      fallback={
        failed ? (
          <div>
            <Button
              onClick={() => {
                setFailed(false);
                retry();
              }}
            >
              {t("firstRun.pi.panelRetry")}
            </Button>
          </div>
        ) : (
          <LoadingLine label={t("firstRun.pi.panelLoading")} cause={cause} deferred={false} />
        )
      }
    >
      <Lazy stepUp={stepUp} />
    </LazyBoundary>
  );
};
