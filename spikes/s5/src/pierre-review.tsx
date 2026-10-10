import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { MultiFileDiff, WorkerPoolContextProvider, type DiffLineAnnotation } from "@pierre/diffs/react";
import pierreWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { useMemo, type ReactElement } from "react";
import type { LineComment } from "./comments.ts";

declare const __WORKER__: boolean;

registerCustomCSSVariableTheme("pap-tokens", {
  foreground: "var(--text)",
  background: "var(--surface)",
  "token-keyword": "var(--agent)",
  "token-string": "var(--ok)",
  "token-string-expression": "var(--ok)",
  "token-constant": "var(--you)",
  "token-comment": "var(--text-dim)",
  "token-function": "var(--text)",
  "token-parameter": "var(--text)",
  "token-punctuation": "var(--text-muted)",
  "token-link": "var(--you)",
});

export interface ReviewProps {
  readonly before: string;
  readonly after: string;
  readonly fileName: string;
  readonly onComment: (line: number, side: LineComment["side"]) => void;
  readonly comments: readonly LineComment[];
}

export function PierreReview({ before, after, fileName, onComment, comments }: ReviewProps): ReactElement {
  const oldFile = useMemo(() => ({ name: fileName, contents: before }), [fileName, before]);
  const newFile = useMemo(() => ({ name: fileName, contents: after }), [fileName, after]);
  const lineAnnotations = useMemo<DiffLineAnnotation<string>[]>(
    () => comments.map((c) => ({ side: c.side === "before" ? "deletions" : "additions", lineNumber: c.line, metadata: c.text })),
    [comments],
  );
  // controlledSelection + selectedLines={null}: otherwise a click on the "+" selects its line and the button stays on it.
  const options = {
    diffStyle: "unified" as const,
    theme: "pap-tokens",
    enableGutterUtility: true,
    controlledSelection: true,
    onGutterUtilityClick: (range: { start: number; side?: "deletions" | "additions" }) => onComment(range.start, range.side === "deletions" ? "before" : "after"),
  };
  const renderAnnotation = (annotation: DiffLineAnnotation<string>) => <div className="review-comment">{annotation.metadata}</div>;
  const diff = <MultiFileDiff<string> oldFile={oldFile} newFile={newFile} lineAnnotations={lineAnnotations} renderAnnotation={renderAnnotation} selectedLines={null} options={options} />;
  if (!__WORKER__) return diff;
  return (
    <WorkerPoolContextProvider poolOptions={{ workerFactory: () => new Worker(pierreWorkerUrl, { type: "module" }), poolSize: 2 }} highlighterOptions={{ theme: "pap-tokens" }}>
      {diff}
    </WorkerPoolContextProvider>
  );
}
