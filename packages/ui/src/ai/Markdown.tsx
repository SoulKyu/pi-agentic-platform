import { Component, lazy, Suspense, type ReactNode } from "react";
import type { CodeCopyLabels } from "./markdown/CodeBlock.tsx";
import type { PathLinks, ShellHandOff } from "./markdown/reply-tools.ts";
import type { RichReplies } from "./markdown/rich-replies.ts";

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

export interface MarkdownProps {
  readonly text: string;
  readonly onLoadError?: () => void;
  /** Code blocks get a copy button when set. */
  readonly copyLabels?: CodeCopyLabels;
  /** Paths in the text become buttons when set. */
  readonly pathLinks?: PathLinks;
  /** Shell blocks get TO TERMINAL when set. */
  readonly shellHandOff?: ShellHandOff;
  /** Images of the box, math, diagrams and previews in the text when set; without it an image is `[image: alt]`. */
  readonly richReplies?: RichReplies;
}

/** Model text as markdown (DESIGN §9.2 message body), loaded on first use; plain text until then and if it fails. */
export function Markdown(props: MarkdownProps) {
  const { text, onLoadError, copyLabels, ...tools } = props;
  const plain = (
    <div data-slot="markdown" className={PLAIN_CLASSES}>
      {text}
    </div>
  );
  return (
    <PlainOnError fallback={plain} onError={onLoadError}>
      <Suspense fallback={plain}>
        <MarkdownBody text={text} copyLabels={copyLabels} {...tools} />
      </Suspense>
    </PlainOnError>
  );
}
