import type { ReactNode } from "react";
import { cn } from "../cn.ts";

export type Author = "agent" | "you" | "tool";

// DESIGN.md §9.2: the agent speaks behind a 2 px violet rule, you in a right-aligned tinted box.
// The label of your box keeps the box's text tone.
const STYLE: Record<Author, { readonly box: string; readonly label: string }> = {
  agent: { box: "border-l-2 border-agent bg-bg px-3 py-2 text-fg", label: "text-agent" },
  you: {
    box: "ml-auto w-fit max-w-prose rounded-md border border-human-line bg-human-tint px-3 py-2 text-human-text",
    label: "",
  },
  tool: { box: "border-l-2 border-line bg-bg px-3 py-2 text-fg", label: "text-muted" },
};

export interface MessageProps {
  readonly author: Author;
  readonly label: string;
  readonly children: ReactNode;
}

export function Message({ author, label, children }: MessageProps) {
  return (
    <article data-author={author} className={STYLE[author].box}>
      <header
        className={cn("font-mono text-label font-semibold uppercase tracking-label", STYLE[author].label)}
      >
        {label}
      </header>
      <div className="mt-1 whitespace-pre-wrap break-words text-chat">{children}</div>
    </article>
  );
}
