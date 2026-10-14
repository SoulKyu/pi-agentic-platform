import { cn } from "@pap/ui";

export interface ThemeCardOption {
  readonly id: string;
  readonly name: string;
  /** "default", "a11y" or "custom": what kind of theme it is. */
  readonly tag: string;
  /** The three swatches of the card (board 08): the side column, the ground and the agent rule. */
  readonly swatch: { readonly side: string; readonly bg: string; readonly agent: string };
}

/** Theme presets and custom themes as cards with colour swatches; the chosen one is pressed. One card per theme, one side per group. */
export function ThemeCards({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly ThemeCardOption[];
  onChange(id: string): void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-s1">
      <span className="label-hud text-muted">{label}</span>
      <div className="flex flex-wrap gap-s2">
        {options.map((option) => {
          const on = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              data-theme-card={option.id}
              aria-pressed={on}
              onClick={() => onChange(option.id)}
              className={cn(
                "flex w-28 flex-col overflow-hidden rounded-md border text-left text-ui focus-ring pointer-coarse:min-h-11",
                on ? "border-you ring-1 ring-you" : "border-border-strong",
              )}
            >
              <span aria-hidden="true" className="flex h-10 w-full">
                <span
                  data-swatch="side"
                  className="w-s4 shrink-0"
                  style={{ background: option.swatch.side }}
                />
                <span
                  data-swatch="bg"
                  className="flex-1 border-l-2"
                  style={{ background: option.swatch.bg, borderLeftColor: option.swatch.agent }}
                />
              </span>
              <span className="flex items-baseline justify-between gap-s1 bg-surface px-s2 py-s1 text-fg">
                <span className="min-w-0 truncate">{option.name}</span>
                <em className="shrink-0 font-mono text-label not-italic text-muted">{option.tag}</em>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
