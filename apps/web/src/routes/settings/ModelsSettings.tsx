import { Button, LoadingLine } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import "../../i18n/register-launch.ts";
import { usePiCauseText } from "../../stores/loading-cause.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useWaitStart, WaitSinceProvider } from "../../lib/wait-since.tsx";
import { useSettingsStepUp } from "./use-settings-step-up.ts";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadModels = () =>
  import("../../features/models/ModelsSection.tsx").then((module) => ({ default: module.ModelsSection }));

/**
 * Settings › Models in a chunk of its own (M7R71). This host owns the password prompt, so the feature does not import
 * the auth feature: it is handed a runner that retries once after M5's inline prompt (M7R70).
 */
export function ModelsSettings() {
  const t = useT();
  const cause = usePiCauseText(t);
  const failureText = useLazyFailureText();
  const { stepUp, prompt } = useSettingsStepUp();
  const { Lazy, attempt, retry } = useRetryableLazy(loadModels);
  const wait = useWaitStart(attempt);
  const [failed, setFailed] = useState(false);

  return (
    <>
      <WaitSinceProvider value={wait}>
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
                  {t("settings.models.retry")}
                </Button>
              </div>
            ) : (
              <LoadingLine
                label={t("settings.models.loading")}
                since={wait.since}
                deferred={false}
                cause={cause}
              />
            )
          }
        >
          <Lazy stepUp={stepUp} />
        </LazyBoundary>
      </WaitSinceProvider>
      {prompt}
    </>
  );
}
