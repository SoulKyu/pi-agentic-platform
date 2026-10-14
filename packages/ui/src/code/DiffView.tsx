import { lazy } from "react";
import type { CodeLabels } from "./CodeEditor.tsx";
import { Lazy } from "./Lazy.tsx";
import type { LanguageLoader } from "./languages.ts";

const Diff = lazy(() => import("./DiffPane.tsx"));

export interface DiffViewProps {
  readonly before: string;
  readonly after: string;
  readonly language?: LanguageLoader | null;
  readonly labels: CodeLabels & { readonly noChanges: string };
  readonly onLoadError?: () => void;
}

/**
 * The S5 diff: a read-only unified merge view of `after` against `before`, loaded on first use. Identical texts
 * say so without loading the editor.
 */
export function DiffView(props: DiffViewProps) {
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
          {props.after}
        </pre>
      }
      onLoadError={props.onLoadError}
    >
      <Diff {...props} />
    </Lazy>
  );
}
