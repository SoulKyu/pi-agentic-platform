import type { ReactNode, Ref } from "react";
import { cn } from "../cn.ts";

export interface HeadingProps {
  readonly level: 2 | 3 | 4;
  readonly variant: "section" | "group" | "card";
  /** `muted` and `agent` colour a card; `attn` is the pink of a block that waits for you (section and group). */
  readonly tone?: "muted" | "agent" | "attn";
  readonly id?: string;
  /** -1 makes the heading a programmatic focus target (a screen moves focus here); it then wears the focus ring. */
  readonly tabIndex?: -1;
  readonly ref?: Ref<HTMLHeadingElement>;
  readonly children: ReactNode;
}

const VARIANTS = {
  section: "text-h2 text-fg",
  group: "text-ui font-semibold text-fg",
} as const;

/** One heading style per role (DESIGN.md §3): section 16/700, group 13/600, card a mono label. */
export function Heading({ level, variant, tone, id, tabIndex, ref, children }: HeadingProps) {
  const Tag = `h${String(level)}` as "h2" | "h3" | "h4";
  const colour = tone === "attn" ? "text-attn" : tone === "agent" ? "text-agent" : "text-muted";
  const style =
    variant === "card"
      ? cn("label-hud", colour)
      : tone === "attn"
        ? VARIANTS[variant].replace("text-fg", colour)
        : VARIANTS[variant];
  return (
    <Tag
      id={id}
      ref={ref}
      tabIndex={tabIndex}
      data-slot="heading"
      className={cn(style, tabIndex === -1 && "focus-ring")}
    >
      {children}
    </Tag>
  );
}
