/**
 * Derived from vercel/ai-elements, packages/elements/src/message.tsx (commit 6a9d5b1),
 * Copyright 2023 Vercel, Inc., Apache License, Version 2.0 (spikes/s6/upstream/LICENSE).
 * Changed by pap: shadcn primitives, the `ai` types and Streamdown are replaced by E1 tokens
 * and owned markup; the branch selector is controlled by the caller instead of counting children.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type Author = "agent" | "you" | "tool";

const RULE: Record<Author, string> = {
  agent: "border-agent",
  you: "border-human",
  tool: "border-line",
};

export interface MessageProps {
  readonly author: Author;
  readonly label: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}

export function Message({ author, label, children, actions }: MessageProps) {
  return (
    <article data-author={author} className={`border-l-2 ${RULE[author]} bg-bg px-3 py-2`}>
      <header className="font-mono text-label uppercase tracking-wider text-muted">{label}</header>
      <div className="mt-1 text-chat text-fg">{children}</div>
      {actions}
    </article>
  );
}

export function MessageActions({ children }: { readonly children: ReactNode }) {
  return <div className="mt-2 flex items-center gap-1">{children}</div>;
}

export interface MessageActionProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "aria-label"> {
  readonly label: string;
}

export function MessageAction({ label, children, type = "button", ...rest }: MessageActionProps) {
  return (
    <button
      type={type}
      className="inline-flex size-6.5 items-center justify-center rounded-sm text-muted hover:bg-panel hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-human disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11"
      {...rest}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

export interface MessageBranchProps {
  readonly index: number;
  readonly count: number;
  readonly previousLabel: string;
  readonly nextLabel: string;
  readonly pageLabel: string;
  onChange(index: number): void;
}

export function MessageBranch({ index, count, previousLabel, nextLabel, pageLabel, onChange }: MessageBranchProps) {
  if (count <= 1) return null;
  return (
    <div role="group" className="flex items-center gap-1">
      <MessageAction label={previousLabel} onClick={() => onChange(index > 0 ? index - 1 : count - 1)}>
        <ChevronLeft size={14} strokeWidth={1.5} aria-hidden="true" />
      </MessageAction>
      <span className="font-mono text-label tabular-nums text-muted">{pageLabel}</span>
      <MessageAction label={nextLabel} onClick={() => onChange(index < count - 1 ? index + 1 : 0)}>
        <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
      </MessageAction>
    </div>
  );
}
