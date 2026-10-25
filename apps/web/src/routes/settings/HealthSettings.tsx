import { Button, LoadingLine } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

// One function for the life of the page: `useRetryableLazy` shares the lazy component by it.
const loadHealth = () =>
  import("../../features/health/HealthSection.tsx").then((module) => ({
    default: module.HealthSection,
  }));

/** Settings › Health in a chunk of its own: the first paint never carries the table or its catalog. */
export function HealthSettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { Lazy, attempt, retry } = useRetryableLazy(loadHealth);
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
              {t("settings.health.retry")}
            </Button>
          </div>
        ) : (
          <LoadingLine label={t("settings.health.loading")} deferred={false} />
        )
      }
    >
      <Lazy />
    </LazyBoundary>
  );
}
