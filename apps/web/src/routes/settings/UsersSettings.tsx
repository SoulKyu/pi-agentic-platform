import { Button, LoadingLine } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useWaitStart, WaitSinceProvider } from "../../lib/wait-since.tsx";
import { useSettingsStepUp } from "./use-settings-step-up.ts";

const loadUsers = () =>
  import("../../features/users/UsersSettings.tsx").then((module) => ({ default: module.UsersSettings }));

/** Settings › Users in a chunk of its own; this host owns the password prompt and hands the feature a runner. */
export function UsersSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { stepUp, prompt } = useSettingsStepUp();
  const { Lazy, attempt, retry } = useRetryableLazy(loadUsers);
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
                  {t("users.retry")}
                </Button>
              </div>
            ) : (
              <LoadingLine label={t("users.loading")} since={wait.since} deferred={false} />
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
