import { Button, LoadingLine } from "@pap/ui";
import { useState } from "react";
import { t, useLazyFailureText } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

const loadInvite = () =>
  import("../../features/auth/InviteScreen.tsx").then((module) => ({ default: module.InviteScreen }));

/** The invitation page is shown once per invited person: its chunk stays out of the initial bundle. */
export function LazyInvite(props: { token: string | null; signedInAs: string | null; onDone(): void }) {
  const failureText = useLazyFailureText();
  const { Lazy, attempt, retry } = useRetryableLazy(loadInvite);
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
          <main className="flex flex-col items-start gap-s3 p-s5">
            <Button
              onClick={() => {
                setFailed(false);
                retry();
              }}
            >
              {t("gate.retry")}
            </Button>
          </main>
        ) : (
          <main className="p-s5">
            <LoadingLine label={t("app.loading")} deferred={false} />
          </main>
        )
      }
    >
      <Lazy {...props} />
    </LazyBoundary>
  );
}
