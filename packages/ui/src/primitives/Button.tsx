import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn.ts";
import { usePendingFeedback } from "../feedback.ts";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BASE_CLASSES =
  "inline-flex shrink-0 items-center justify-center gap-s1 whitespace-nowrap rounded-sm border label-hud select-none transition-colors duration-fast focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-you-fill bg-you-fill text-you-ink can-hover:hover:opacity-90",
  secondary: "border-control-border bg-surface text-fg can-hover:hover:bg-surface-2",
  ghost: "border-transparent bg-transparent text-fg can-hover:hover:bg-surface-2",
  // Irreversible actions only. Cancel, Stop and Deny are never danger (DESIGN.md §9.1, R21).
  danger: "border-err bg-transparent text-err can-hover:hover:bg-surface-2",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-6 px-s2",
  md: "h-control px-s3",
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** When the action started (a performance.now() reading from the handler), null when idle. */
  readonly pendingSince?: number | null;
  /** Remote actions disable at once and spin after about 200 ms (default). */
  readonly remote?: boolean;
  /** Replaces the label after 3 s ("Preparing worktree…"). */
  readonly stageLabel?: string;
}

// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Button({
  variant,
  size,
  type,
  pendingSince,
  remote,
  stageLabel,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const phase = usePendingFeedback(pendingSince ?? null, { remote: remote ?? true });
  const busy = phase === "disabled" || phase === "spinner" || phase === "stage";
  return (
    <button
      type={type ?? "button"}
      data-slot="button"
      data-variant={variant ?? "secondary"}
      aria-busy={busy || undefined}
      disabled={disabled === true || busy}
      className={cn(BASE_CLASSES, BUTTON_VARIANTS[variant ?? "secondary"], BUTTON_SIZES[size ?? "md"])}
      {...rest}
    >
      {phase === "spinner" || phase === "stage" ? <Spinner /> : null}
      {phase === "stage" && stageLabel ? stageLabel : children}
    </button>
  );
}
