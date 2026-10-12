import { cn } from "@pap/ui";
import { parseAnsi, type AnsiTone } from "./ansi.ts";

// M1 token classes; P1 renames them after the M3 merge (`text-muted` stands for `--text-dim`, M1 has none).
const TONE_CLASS: Record<AnsiTone, string> = {
  dim: "text-muted",
  error: "text-error",
  ok: "text-ok",
  you: "text-human",
  agent: "text-agent",
  attention: "text-attention",
  text: "text-fg",
};

/** One line of extension text as React spans on role tokens; never HTML (DESIGN.md §9.2). */
export function AnsiText({ text }: { readonly text: string }) {
  return parseAnsi(text).map((span, index) => (
    <span
      // The list is rebuilt whole from the text on each render: the index is its identity.
      key={index}
      className={cn(
        span.tone ? TONE_CLASS[span.tone] : null,
        span.faint ? "text-muted" : null,
        span.bold ? "font-semibold" : null,
        span.italic ? "italic" : null,
        span.underline ? "underline" : null,
      )}
    >
      {span.text}
    </span>
  ));
}
