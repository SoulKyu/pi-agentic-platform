import { Button } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useSettingsStepUp } from "./use-settings-step-up.ts";

const loadGithub = () =>
  import("../../features/github/GithubSettings.tsx").then((module) => ({ default: module.GithubSettings }));

/** Settings › GitHub in a chunk of its own; this host owns the password prompt (M7R70) and hands the feature a runner. */
export function GithubSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { stepUp, prompt } = useSettingsStepUp();
  const { Lazy, attempt, retry } = useRetryableLazy(loadGithub);
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
              {t("settings.github.loading")}
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
