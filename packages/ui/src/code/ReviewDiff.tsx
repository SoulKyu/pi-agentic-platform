import { lazy, type ReactNode } from "react";
import type { CodeLabels } from "./CodeEditor.tsx";
import { Lazy } from "./Lazy.tsx";
import type { LanguageLoader } from "./languages.ts";
import { showHidden } from "./review-text.ts";
import type { DiffComment, DiffSideName, EditingTarget } from "./review-widgets.ts";

const Pane = lazy(() => import("./ReviewDiffPane.tsx"));

export interface ReviewDiffViewProps {
  readonly before: string;
  readonly after: string;
  readonly language?: LanguageLoader | null;
  readonly labels: CodeLabels & { readonly noChanges: string };
  readonly comments: readonly DiffComment[];
  /** The line a comment is being written on; `editor` is drawn under it, in the diff. */
  readonly editing?: EditingTarget | null;
  readonly editor?: ReactNode;
  onComment(line: number, side: DiffSideName): void;
  onOpenComment(id: string): void;
  readonly onLoadError?: () => void;
}

/**
 * The review diff (M9R87): the S5 merge view with a comment gutter and comment blocks, loaded on first use. Identical
 * texts say so without loading the editor. Comment text is set as `textContent`, never as markup.
 */
export function ReviewDiffView(props: ReviewDiffViewProps) {
  if (props.before === props.after)
    return (
      <p data-slot="diff-empty" className="p-s3 text-ui text-muted">
        {props.labels.noChanges}
      </p>
    );
  return (
    <Lazy
      fallback={
        <pre
          data-slot="diff-view"
          data-state="plain"
          className="h-full overflow-auto p-s2 font-mono text-code text-fg"
        >
          {showHidden(props.after)}
        </pre>
      }
      onLoadError={props.onLoadError}
    >
      <Pane {...props} />
    </Lazy>
  );
}

export type { DiffComment, DiffSideName, EditingTarget } from "./review-widgets.ts";
