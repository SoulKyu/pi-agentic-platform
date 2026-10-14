import { Button } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
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
  const failureText = useLazyFailureText();
  const { stepUp, prompt } = useSettingsStepUp();
  const { Lazy, attempt, retry } = useRetryableLazy(loadModels);
  const [failed, setFailed] = useState(false);

  return (
    <>
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
            <p role="status" className="text-ui text-muted">
              {t("settings.models.loading")}
            </p>
          )
        }
      >
        <Lazy stepUp={stepUp} />
      </LazyBoundary>
      {prompt}
    </>
  );
}
