import { useEffect, useState } from "react";
import type { CodeToken } from "./highlight.ts";

const PRE_CLASSES = "overflow-x-auto rounded-md border border-border bg-surface p-s2 font-mono text-code";
let warned = false;
// Outside the component: the React Compiler cannot lower a dynamic import. shiki loads with the first code block.
const loadHighlighter = () => import("./highlight.ts");

/** Plain first; the highlighted tokens replace it when they arrive for the same code (a stale answer is dropped). */
export function CodeBlock({ code, lang }: { readonly code: string; readonly lang: string }) {
  const [highlighted, setHighlighted] = useState<{
    readonly code: string;
    readonly lang: string;
    readonly lines: CodeToken[][];
  } | null>(null);
  useEffect(() => {
    let current = true;
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
    return () => {
      current = false;
    };
  }, [code, lang]);
  const lines =
    highlighted && highlighted.code === code && highlighted.lang === lang ? highlighted.lines : null;
  return (
    <pre data-slot="code-block" data-lang={lang || undefined} className={PRE_CLASSES}>
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
}
