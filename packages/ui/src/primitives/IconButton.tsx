import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn.ts";
import type { IconGlyph } from "../icons.ts";
import { Icon } from "./Icon.tsx";
import { Tooltip } from "./Tooltip.tsx";

const ICON_BUTTON_BASE_CLASSES =
  "relative inline-flex shrink-0 items-center justify-center rounded-sm border transition-colors duration-fast focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:cursor-not-allowed disabled:opacity-50";
const ICON_BUTTON_VARIANTS = {
  ghost: "border-transparent bg-transparent text-muted can-hover:hover:bg-surface-2 can-hover:hover:text-fg",
  secondary: "border-control-border bg-surface text-fg can-hover:hover:bg-surface-2",
} as const;
const ICON_BUTTON_SIZES = { sm: "size-6", md: "size-control" } as const;

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style" | "children" | "aria-label" | "title"
> {
  readonly icon: IconGlyph;
  /** Mandatory: the accessible name and the tooltip (DESIGN.md §7.1). */
  readonly label: string;
  readonly shortcut?: readonly string[];
  readonly shortcutJoiner?: "" | "+";
  readonly variant?: keyof typeof ICON_BUTTON_VARIANTS;
  readonly size?: keyof typeof ICON_BUTTON_SIZES;
}

// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function IconButton({
  icon,
  label,
  shortcut,
  shortcutJoiner,
  variant,
  size,
  type,
  ...rest
}: IconButtonProps) {
  const sizeKey = size ?? "md";
  return (
    <Tooltip label={label} shortcut={shortcut} shortcutJoiner={shortcutJoiner}>
      <button
        type={type ?? "button"}
        data-slot="icon-button"
        aria-label={label}
        className={cn(
          ICON_BUTTON_BASE_CLASSES,
          ICON_BUTTON_VARIANTS[variant ?? "ghost"],
          ICON_BUTTON_SIZES[sizeKey],
        )}
        {...rest}
      >
        <Icon icon={icon} size={sizeKey === "sm" ? 14 : 16} />
      </button>
    </Tooltip>
  );
}
