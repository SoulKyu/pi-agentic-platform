import type { IconGlyph } from "../icons.ts";

export interface IconProps {
  readonly icon: IconGlyph;
  readonly size?: 14 | 16 | 20 | 28;
  /** Only for an icon that carries meaning on its own; decorative otherwise. */
  readonly label?: string;
  /** Solid glyph: `fill="currentColor"`. */
  readonly filled?: boolean;
}

/** DESIGN.md §7.1: lucide at a 1.5 px stroke in currentColor, 16 px by default, 14 px in compact rows. */
// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Icon({ icon: Glyph, size, label, filled }: IconProps) {
  return (
    <Glyph
      data-slot="icon"
      size={size ?? 16}
      strokeWidth={1.5}
      fill={filled ? "currentColor" : undefined}
      focusable="false"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
