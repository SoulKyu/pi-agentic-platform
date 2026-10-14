import { Component, Suspense, type ReactNode } from "react";

interface Props {
  readonly fallback: ReactNode;
  readonly onLoadError?: (() => void) | undefined;
  readonly children: ReactNode;
}

/** The plain fallback stays when the chunk cannot load (an update renamed it while the page stayed open); the failure is reported once. */
class PlainOnError extends Component<Props, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onLoadError?.();
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Suspense plus the failure fallback, shared by the editor and the diff view. */
export function Lazy({ fallback, onLoadError, children }: Props) {
  return (
    <PlainOnError fallback={fallback} onLoadError={onLoadError}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </PlainOnError>
  );
}
