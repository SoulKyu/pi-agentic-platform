import { Button, EmptyState } from "@pap/ui";
import type { ComponentType } from "react";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

interface LazyPaneProps<P extends object> {
  readonly load: () => Promise<{ default: ComponentType<P> }>;
  readonly props: P;
}

/**
 * A lazy screen that fills a pane and cannot be closed on failure (M3R109): one failure says so once and shows a
 * Retry state; it never retries by itself. Retry imports again; a stale chunk keeps failing until the page reloads.
 */
export function LazyPane<P extends object>({ load, props }: LazyPaneProps<P>) {
  const t = useT();
  const { Lazy, attempt, retry } = useRetryableLazy(load);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <EmptyState
        title={t("shell.lazyPane.title")}
        purpose={t("shell.lazyFailed")}
        action={
          <Button
            variant="primary"
            onClick={() => {
              setFailed(false);
              retry();
            }}
          >
            {t("gate.retry")}
          </Button>
        }
      />
    );
  }
  return (
    <LazyBoundary
      resetKey={attempt}
      onError={() => {
        setFailed(true);
        notifyLazyFailure({ message: t("shell.lazyFailed"), reload: t("shell.reload") });
      }}
    >
      <Lazy {...props} />
    </LazyBoundary>
  );
}
