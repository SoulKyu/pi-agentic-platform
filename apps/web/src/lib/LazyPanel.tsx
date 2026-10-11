import type { ComponentType } from "react";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy, type LazyFailureText } from "./lazy.tsx";

interface LazyPanelProps<P extends object> {
  readonly load: () => Promise<{ default: ComponentType<P> }>;
  readonly open: boolean;
  readonly props: P;
  readonly text: LazyFailureText;
  /** Called when the chunk did not load or the panel threw: the owner closes it. */
  onFailed(): void;
}

/**
 * A panel that is fetched on first open and mounted only while `open` (M3-RT-15): a stale chunk closes the panel,
 * says to reload, and the next open tries again with a fresh import.
 */
export function LazyPanel<P extends object>({ load, open, props, text, onFailed }: LazyPanelProps<P>) {
  const { Lazy, attempt, retry } = useRetryableLazy(load);
  if (!open) return null;
  return (
    <LazyBoundary
      resetKey={attempt}
      onError={(error) => {
        onFailed();
        retry();
        notifyLazyFailure(error, text);
      }}
    >
      <Lazy {...props} />
    </LazyBoundary>
  );
}
