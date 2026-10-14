import { Button } from "@pap/ui";
import { useState } from "react";
import { t, useLazyFailureText } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadFirstRun = () => import("./FirstRun.tsx").then((module) => ({ default: module.FirstRun }));

/** The stepper's chunk is shown once per install. A chunk that fails to load leaves a retry on the screen. */
export function LazyFirstRun({ onDone, onAccountCreated }: { onDone(): void; onAccountCreated(): void }) {
  const failureText = useLazyFailureText();
  const { Lazy, attempt, retry } = useRetryableLazy(loadFirstRun);
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
          <main className="flex flex-col items-start gap-3 p-6">
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
          <main className="p-6 text-muted">{t("app.loading")}</main>
        )
      }
    >
      <Lazy onDone={onDone} onAccountCreated={onAccountCreated} />
    </LazyBoundary>
  );
}
