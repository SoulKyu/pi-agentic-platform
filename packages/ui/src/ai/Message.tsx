/**
 * Message actions and branch selector derived from vercel/ai-elements, packages/elements/src/message.tsx
 * (commit 6a9d5b1), Copyright 2023 Vercel, Inc., Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
 * Changed by pap: shadcn primitives, the `ai` types and Streamdown are replaced by DESIGN.md tokens and owned
 * markup; the branch selector is controlled by the caller; the group carries an accessible name.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../cn.ts";
import { IconChevronLeft, IconChevronRight, type IconGlyph } from "../icons.ts";
import { Icon } from "../primitives/Icon.tsx";
import { Tooltip } from "../primitives/Tooltip.tsx";

export type Author = "agent" | "you" | "tool";

// DESIGN.md §9.2: the agent speaks behind a 2 px violet rule, you in a right-aligned tinted box.
const STYLE: Record<Author, { readonly box: string; readonly label: string }> = {
  agent: { box: "border-l-2 border-agent px-s3 py-s2 text-fg", label: "text-agent" },
  you: {
    box: "ml-auto w-fit max-w-prose rounded-md border border-you-line bg-you-tint px-s3 py-s2 text-you-text",
    label: "",
  },
  tool: { box: "border-l-2 border-border px-s3 py-s2 text-fg", label: "text-muted" },
};

export interface MessageProps {
  readonly author: Author;
  readonly label: string;
  readonly children: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  /** Inside an AuthorGroup: the group's header stands for this message's. */
  readonly grouped?: boolean;
}

// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Message({ author, label, children, meta, actions, grouped }: MessageProps) {
  const inGroup = grouped ?? false;
  return (
    <article
      data-slot="message"
      data-author={author}
      aria-label={inGroup ? label : undefined}
      className={STYLE[author].box}
    >
      {inGroup ? null : (
        <header className="flex items-baseline gap-s2">
          <span className={cn("label-hud", STYLE[author].label)}>{label}</span>
          {meta ? <span className="font-mono text-label tabular-nums text-muted">{meta}</span> : null}
        </header>
      )}
      <div className={cn("whitespace-pre-wrap break-words text-chat", inGroup ? null : "mt-s1")}>
        {children}
      </div>
      {actions}
    </article>
  );
}

export function MessageActions({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="mt-s2 flex items-center gap-s1">
      {children}
    </div>
  );
}

export interface MessageActionProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style" | "aria-label" | "children" | "title"
> {
  readonly label: string;
  readonly icon: IconGlyph;
}

const ACTION_CLASSES =
  "inline-flex size-control items-center justify-center rounded-sm text-muted transition-colors duration-fast focus-ring can-hover:hover:bg-surface-2 can-hover:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11";

export function MessageAction({ label, icon, type, ...rest }: MessageActionProps) {
  return (
    <Tooltip label={label}>
      <button type={type ?? "button"} aria-label={label} className={ACTION_CLASSES} {...rest}>
        <Icon icon={icon} size={14} />
      </button>
    </Tooltip>
  );
}

export interface MessageBranchProps {
  readonly index: number;
  readonly count: number;
  readonly groupLabel: string;
  readonly previousLabel: string;
  readonly nextLabel: string;
  /** "2 / 3", formatted by the caller. */
  readonly position: string;
  onChange(index: number): void;
}

export function MessageBranch({
  index,
  count,
  groupLabel,
  previousLabel,
  nextLabel,
  position,
  onChange,
}: MessageBranchProps) {
  if (count <= 1) return null;
  return (
    <div role="group" aria-label={groupLabel} className="flex items-center gap-s1">
      <MessageAction
        label={previousLabel}
        icon={IconChevronLeft}
        onClick={() => onChange(index > 0 ? index - 1 : count - 1)}
      />
      <span className="font-mono text-label tabular-nums text-muted">{position}</span>
      <MessageAction
        label={nextLabel}
        icon={IconChevronRight}
        onClick={() => onChange(index < count - 1 ? index + 1 : 0)}
      />
    </div>
  );
}
