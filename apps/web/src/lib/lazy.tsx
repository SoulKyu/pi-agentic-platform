import { toast } from "@pap/ui";
import {
  Component,
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { reportClientIssue } from "./report.ts";

interface BoundaryProps {
  readonly resetKey: number;
  onError(): void;
  readonly children: ReactNode;
}

/**
 * Around every lazy chunk (M3-RT-15): a chunk that fails to load (an open tab after a pap update, whose old file
 * name is gone) or a lazy panel that throws renders nothing and calls `onError` once; a new `resetKey` re-arms it.
 * The shell stays standing instead of TanStack's root error screen.
 */
export class LazyBoundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError();
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? null : <Suspense fallback={null}>{this.props.children}</Suspense>;
  }
}

/** A lazy component that can try again: React keeps a rejected import inside a lazy component for good. */
export function useRetryableLazy<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): {
  Lazy: LazyExoticComponent<ComponentType<P>>;
  attempt: number;
  retry(): void;
} {
  const [Lazy, setLazy] = useState(() => lazy(load));
  const [attempt, setAttempt] = useState(0);
  return {
    Lazy,
    attempt,
    retry: () => {
      setLazy(() => lazy(load));
      setAttempt((value) => value + 1);
    },
  };
}

/** One line in the client log and a toast with Reload; the strings come translated from the caller. */
export function notifyLazyFailure(text: { readonly message: string; readonly reload: string }): void {
  reportClientIssue("lazy_chunk_failed");
  toast({
    message: text.message,
    tone: "error",
    action: { label: text.reload, altText: text.reload, run: () => window.location.reload() },
  });
}
