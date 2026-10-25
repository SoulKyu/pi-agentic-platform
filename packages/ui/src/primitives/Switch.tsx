import { Switch as Radix } from "radix-ui";
import { useId, type ReactNode } from "react";

export interface SwitchProps {
  readonly label: string;
  readonly checked: boolean;
  onChange(checked: boolean): void;
  readonly hint?: string;
  readonly disabled?: boolean;
  /** Sits between the label column and the track (a count, a status). */
  readonly meta?: ReactNode;
}

/** Square, no pill (DESIGN.md §9.1). */
export function Switch({ label, checked, onChange, hint, disabled, meta }: SwitchProps) {
  const id = useId();
  return (
    <div
      data-slot="switch"
      className="relative flex items-center justify-between gap-s3 pointer-coarse:min-h-11"
    >
      <div className="flex flex-col gap-s1">
        <label id={`${id}-label`} htmlFor={id} className="text-ui text-fg">
          {label}
        </label>
        {hint ? (
          <span id={`${id}-hint`} className="text-pretty text-ui text-muted">
            {hint}
          </span>
        ) : null}
      </div>
      {meta ? <div className="ml-auto shrink-0 text-ui text-muted">{meta}</div> : null}
      <Radix.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="relative inline-flex h-4 w-8 shrink-0 items-center rounded-sm border border-control-border bg-surface p-0.5 transition-colors duration-fast focus-ring state-checked:border-agent-fill state-checked:bg-agent-fill disabled:opacity-50 pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1.75 pointer-coarse:before:-inset-y-3.75"
      >
        <Radix.Thumb className="block size-2.5 rounded-sm bg-fg transition-transform duration-fast state-checked:translate-x-4 state-checked:bg-agent-ink" />
      </Radix.Root>
    </div>
  );
}
