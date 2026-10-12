export interface MarkProps {
  readonly size?: number;
  /** Pins a theme's tones (data-theme on the svg); by default the mark follows the page's theme. */
  readonly mode?: "night" | "day";
  /** Accessible name; decorative without one. */
  readonly label?: string;
}

/** DESIGN.md §6.1: an agent and a human under one roof. Agent is always left and violet, you always right and orange. */
// The default is read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Mark(props: MarkProps) {
  const px = Math.max(16, props.size ?? 24);
  const { mode, label } = props;
  return (
    <svg
      data-slot="mark"
      data-theme={mode}
      viewBox="0 0 32 32"
      width={px}
      height={px}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <rect className="fill-fg" x="6" y="9" width="20" height="3.2" />
      <rect className="fill-agent" x="10.4" y="12" width="3.2" height="13" />
      <path className="fill-you" d="M18.6 12h3.2v9.4c0 1.4.5 2 1.6 2h.9V26h-1.6c-2.8 0-4.1-1.4-4.1-4.4z" />
    </svg>
  );
}
