import { Button, LoadingLine } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useWaitStart, WaitSinceProvider } from "../../lib/wait-since.tsx";
import { useSettingsStepUp } from "./use-settings-step-up.ts";

const loadGithub = () =>
  import("../../features/github/GithubSettings.tsx").then((module) => ({ default: module.GithubSettings }));

/** Settings › GitHub in a chunk of its own; this host owns the password prompt (M7R70) and hands the feature a runner. */
export function GithubSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { stepUp, prompt } = useSettingsStepUp();
  const { Lazy, attempt, retry } = useRetryableLazy(loadGithub);
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
              <LoadingLine label={t("settings.github.loading")} since={wait.since} deferred={false} />
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
