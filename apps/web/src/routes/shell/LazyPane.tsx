import { Button, EmptyState } from "@pap/ui";
import type { ComponentType } from "react";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { isStaleChunk, LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";

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
  const text = useLazyFailureText();
  const { Lazy, attempt, retry } = useRetryableLazy(load);
  const [failure, setFailure] = useState<string | null>(null);
  if (failure !== null) {
    return (
      <EmptyState
        title={t("shell.lazyPane.title")}
        purpose={failure}
        action={
          <Button
            variant="primary"
            onClick={() => {
              setFailure(null);
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
      onError={(error) => {
        setFailure(isStaleChunk(error) ? text.stale : text.broken);
        notifyLazyFailure(error, text);
      }}
    >
      <Lazy {...props} />
    </LazyBoundary>
  );
}
