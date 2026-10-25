import { useEffect, useState } from "react";
import { copyText } from "../../clipboard.ts";
import { cn } from "../../cn.ts";
import { IconCheck, IconCopy } from "../../icons.ts";
import { MessageAction } from "../Message.tsx";
import type { CodeToken } from "./highlight.ts";

const PRE_CLASSES = "overflow-x-auto rounded-md border border-border bg-surface p-s2 font-mono text-code";
const COPIED_MS = 1500;

export interface CodeCopyLabels {
  readonly copy: string;
  readonly copied: string;
}

function CopyCode({ code, labels }: { readonly code: string; readonly labels: CodeCopyLabels }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <MessageAction
      label={copied ? labels.copied : labels.copy}
      icon={copied ? IconCheck : IconCopy}
      onClick={() => void copyText(code).then(setCopied)}
    />
  );
}
/** A reply streams a delta every few milliseconds: the colour waits until the block has been quiet this long. */
const SETTLE_MS = 400;
let warned = false;
// Outside the component: the React Compiler cannot lower a dynamic import. shiki loads with the first code block.
const loadHighlighter = () => import("./highlight.ts");

/**
 * Plain first; the highlighted tokens replace it when they arrive for the same code (a stale answer is dropped).
 * Highlighting starts only once the code has stopped changing, so a streaming fence is never highlighted per delta.
 */
export function CodeBlock({
  code,
  lang,
  labels,
}: {
  readonly code: string;
  readonly lang: string;
  /** With labels, a copy button sits in the top right corner, always visible (touch has no hover). */
  readonly labels?: CodeCopyLabels;
}) {
  const [highlighted, setHighlighted] = useState<{
    readonly code: string;
    readonly lang: string;
    readonly lines: CodeToken[][];
  } | null>(null);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      loadHighlighter()
        .then(({ highlightCode }) => highlightCode(code, lang))
        .then(
          (lines) => {
            if (current && lines) setHighlighted({ code, lang, lines });
          },
          () => {
            // Highlighting only adds colour: the plain block stays on screen. One bounded line per page, no content.
            if (warned) return;
            warned = true;
            console.warn("pap: code_highlight_failed");
          },
        );
    }, SETTLE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [code, lang]);
  const lines =
    highlighted && highlighted.code === code && highlighted.lang === lang ? highlighted.lines : null;
  const pre = (
    <pre
      data-slot="code-block"
      data-lang={lang || undefined}
      className={cn(PRE_CLASSES, labels && "pr-control")}
    >
      <code>
        {lines
          ? lines.map((line, row) => (
              <span key={row} className="block">
                {line.map((token, column) => (
                  <span
                    key={column}
                    className={token.italic ? "italic" : undefined}
                    style={token.color ? { color: token.color } : undefined}
                  >
                    {token.content}
                  </span>
                ))}
              </span>
            ))
          : code}
      </code>
    </pre>
  );
  if (!labels) return pre;
  return (
    <div className="relative">
      {pre}
      <div className="absolute top-s1 right-s1 rounded-sm bg-surface">
        <CopyCode code={code} labels={labels} />
      </div>
    </div>
  );
}
