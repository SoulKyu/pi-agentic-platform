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
  onError(error: unknown): void;
  /** Shown while the chunk loads and after a failure (until the next `resetKey`); nothing by default. */
  readonly fallback?: ReactNode;
  readonly children: ReactNode;
}

// What browsers throw when a lazy chunk is gone after an update: Chromium, Safari, Firefox, bundler wording.
const STALE_CHUNK =
  /dynamically imported module|importing a module script failed|error loading dynamically|ChunkLoadError/i;

const looksStale = (error: unknown): boolean =>
  error instanceof Error && (STALE_CHUNK.test(error.message) || error.name === "ChunkLoadError");

/** A wrapper that re-throws the import failure (a bundler helper, the test runner's mock) keeps it as `cause`. */
export const isStaleChunk = (error: unknown): boolean =>
  looksStale(error) || (error instanceof Error && looksStale(error.cause));

/** What a failed lazy part says, translated by the caller (`lib/` does not import the catalogs). */
export interface LazyFailureText {
  /** A chunk that is gone: pap was updated. */
  readonly stale: string;
  /** Any other failure of the part itself. */
  readonly broken: string;
  readonly reload: string;
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

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override render(): ReactNode {
    const fallback = this.props.fallback ?? null;
    return this.state.failed ? fallback : <Suspense fallback={fallback}>{this.props.children}</Suspense>;
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

/**
 * One line in the client log and a toast with Reload. A chunk that is gone says pap was updated; a part that threw
 * says it stopped working, so a render bug is not blamed on an update.
 */
export function notifyLazyFailure(error: unknown, text: LazyFailureText): void {
  const stale = isStaleChunk(error);
  reportClientIssue(stale ? "lazy_chunk_failed" : "render_failed");
  toast({
    message: stale ? text.stale : text.broken,
    tone: "error",
    action: { label: text.reload, altText: text.reload, run: () => window.location.reload() },
  });
}
