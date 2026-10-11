import { Switch as Radix } from "radix-ui";
import { useId } from "react";

export interface SwitchProps {
  readonly label: string;
  readonly checked: boolean;
  onChange(checked: boolean): void;
  readonly hint?: string;
  readonly disabled?: boolean;
}

/** Square, no pill (DESIGN.md §9.1). */
export function Switch({ label, checked, onChange, hint, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div data-slot="switch" className="flex items-center justify-between gap-s3">
      <div className="flex flex-col gap-s1">
        <span id={`${id}-label`} className="text-ui text-fg">
          {label}
        </span>
        {hint ? (
          <span id={`${id}-hint`} className="text-ui text-muted">
            {hint}
          </span>
        ) : null}
      </div>
      <Radix.Root
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="relative inline-flex h-4 w-8 shrink-0 items-center rounded-sm border border-control-border bg-surface p-0.5 transition-colors duration-fast focus-ring state-checked:border-agent-fill state-checked:bg-agent-fill disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <Radix.Thumb className="block size-2.5 rounded-sm bg-fg transition-transform duration-fast state-checked:translate-x-4 state-checked:bg-agent-ink" />
      </Radix.Root>
    </div>
  );
}
