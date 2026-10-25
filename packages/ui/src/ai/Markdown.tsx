import { Component, lazy, Suspense, type ReactNode } from "react";
import type { CodeCopyLabels } from "./markdown/CodeBlock.tsx";

const MarkdownBody = lazy(() => import("./markdown/render.tsx"));
const PLAIN_CLASSES = "whitespace-pre-wrap break-words";

interface FallbackProps {
  readonly fallback: ReactNode;
  readonly onError?: () => void;
  readonly children: ReactNode;
}

/** A chunk that fails to load (an update renamed it while the page stayed open) or a renderer that throws leaves the plain text. */
class PlainOnError extends Component<FallbackProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError?.();
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Model text as markdown (DESIGN §9.2 message body), loaded on first use; plain text until then and if it fails. */
export function Markdown({
  text,
  onLoadError,
  copyLabels,
}: {
  readonly text: string;
  readonly onLoadError?: () => void;
  /** Code blocks get a copy button when set. */
  readonly copyLabels?: CodeCopyLabels;
}) {
  const plain = (
    <div data-slot="markdown" className={PLAIN_CLASSES}>
      {text}
    </div>
  );
  return (
    <PlainOnError fallback={plain} onError={onLoadError}>
      <Suspense fallback={plain}>
        <MarkdownBody text={text} copyLabels={copyLabels} />
      </Suspense>
    </PlainOnError>
  );
}
