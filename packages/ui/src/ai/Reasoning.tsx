/**
 * Derived from vercel/ai-elements, packages/elements/src/reasoning.tsx (commit 6a9d5b1), Copyright 2023 Vercel, Inc.,
 * Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md). Changed by pap: Shimmer, Streamdown and the motion
 * classes are removed (DESIGN.md §1, §7.2); the label and its duration come from the caller (Pi timestamps); open
 * state is only the person's click.
 */
import { useState, type ReactNode } from "react";
import { IconChevronRight } from "../icons.ts";
import { Collapsible } from "../primitives/Collapsible.tsx";
import { Icon } from "../primitives/Icon.tsx";

export interface ReasoningProps {
  /** Unread: a click opens and closes the block, nothing else does. Callers pass the label that says which. */
  readonly streaming?: boolean;
  /** "Thinking…" while streaming, "Thought for 14s" after. */
  readonly label: string;
  readonly children: ReactNode;
}

export function Reasoning({ label, children }: ReasoningProps) {
  const [open, setOpen] = useState(false);
  return (
    <div data-slot="reasoning">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        trigger={
          <span className="flex items-center gap-s1 text-ui text-muted">
            <span
              className={
                open ? "rotate-90 transition-transform duration-fast" : "transition-transform duration-fast"
              }
            >
              <Icon icon={IconChevronRight} size={14} />
            </span>
            {label}
          </span>
        }
      >
        <div className="mt-s1 border-l border-border pl-s3 text-chat text-muted">{children}</div>
      </Collapsible>
    </div>
  );
}
