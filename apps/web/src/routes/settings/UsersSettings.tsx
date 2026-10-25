import { Button } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { useSettingsStepUp } from "./use-settings-step-up.ts";

const loadUsers = () =>
  import("../../features/users/UsersSettings.tsx").then((module) => ({ default: module.UsersSettings }));

/** Settings › Users in a chunk of its own; this host owns the password prompt and hands the feature a runner. */
export function UsersSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { stepUp, prompt } = useSettingsStepUp();
  const { Lazy, attempt, retry } = useRetryableLazy(loadUsers);
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
                {t("users.retry")}
              </Button>
            </div>
          ) : (
            <p role="status" className="text-ui text-muted">
              {t("users.loading")}
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
