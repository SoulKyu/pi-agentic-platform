import { cn } from "../cn.ts";

const WORDMARK_SIZES = { default: "text-h1", compact: "text-ui" } as const;

/**
 * DESIGN.md §6.2: `pap` in Manrope 800, −0.02em, lower case; the optional tagline in mono upper case, muted.
 * `compact` is the top bar's name (board 06 `.wm4`, 13 px = `text-ui`); the default is the auth frame's.
 */
export function Wordmark({
  name,
  tagline,
  compact,
}: {
  readonly name: string;
  readonly tagline?: string;
  readonly compact?: boolean;
}) {
  return (
    <span data-slot="wordmark" className="inline-flex items-baseline gap-s2">
      <span
        className={cn(
          "font-sans font-extrabold tracking-display lowercase text-fg",
          WORDMARK_SIZES[compact === true ? "compact" : "default"],
        )}
      >
        {name}
      </span>
      {tagline ? <span className="label-hud text-muted">{tagline}</span> : null}
    </span>
  );
}
