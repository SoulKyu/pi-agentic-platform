import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn.ts";
import { FOCUS_RING } from "../focus.ts";

type Variant = "primary" | "secondary" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-human-fill text-on-fill hover:opacity-90",
  secondary: "border border-line bg-panel text-fg hover:border-muted",
  danger: "border border-error bg-bg text-error hover:bg-panel",
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  readonly variant?: Variant;
}

// DESIGN.md §9.1 sets button labels in mono uppercase: deferred to M3 with the full token schema.
export function Button({ variant = "secondary", type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-6.5 items-center justify-center rounded-sm px-3 font-sans text-ui font-semibold pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        FOCUS_RING,
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
      )}
      {...rest}
    />
  );
}
