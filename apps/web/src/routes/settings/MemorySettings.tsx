import { Button } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

const loadMemory = () =>
  import("../../features/memory/MemorySettings.tsx").then((module) => ({ default: module.MemorySettings }));

/** Settings › Memory in a chunk of its own (M11R150): the first paint never carries it. */
export function MemorySettings() {
  const t = useT();
  const failureText = useLazyFailureText();
  const { Lazy, attempt, retry } = useRetryableLazy(loadMemory);
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
              {t("settings.memory.retry")}
            </Button>
          </div>
        ) : (
          <p role="status" className="text-ui text-muted">
            {t("settings.memory.loading")}
          </p>
        )
      }
    >
      <Lazy />
    </LazyBoundary>
  );
}
