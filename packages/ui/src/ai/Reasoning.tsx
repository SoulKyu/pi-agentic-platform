/**
 * Derived from vercel/ai-elements, packages/elements/src/reasoning.tsx (commit 6a9d5b1), Copyright 2023 Vercel, Inc.,
 * Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md). Changed by pap: Shimmer, Streamdown and the motion
 * classes are removed (DESIGN.md §1, §7.2); the label and its duration come from the caller (Pi timestamps); open
 * state is derived without setting state inside an effect body.
 */
import { useEffect, useState, type ReactNode } from "react";
import { IconChevronRight } from "../icons.ts";
import { Collapsible } from "../primitives/Collapsible.tsx";
import { Icon } from "../primitives/Icon.tsx";

const AUTO_CLOSE_MS = 1000;

export interface ReasoningProps {
  readonly streaming: boolean;
  /** "Thinking…" while streaming, "Thought for 14s" after. */
  readonly label: string;
  readonly children: ReactNode;
}

export function Reasoning({ streaming, label, children }: ReasoningProps) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [previous, setPrevious] = useState(streaming);
  const [lingering, setLingering] = useState(false);
  // React's "adjust state when a prop changes" pattern: the stream just ended, stay open for a second.
  if (streaming !== previous) {
    setPrevious(streaming);
    setLingering(!streaming);
  }
  useEffect(() => {
    if (!lingering) return;
    const timer = window.setTimeout(() => setLingering(false), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [lingering]);
  const open = chosen ?? (streaming || lingering);
  return (
    <div data-slot="reasoning">
      <Collapsible
        open={open}
        onOpenChange={setChosen}
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
