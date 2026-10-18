import { Checkbox as Radix } from "radix-ui";
import { useId } from "react";
import { IconCheck } from "../icons.ts";
import { Icon } from "./Icon.tsx";

export interface CheckboxProps {
  readonly label: string;
  readonly checked: boolean;
  onChange(checked: boolean): void;
  readonly disabled?: boolean;
}

/** A 16 px square box; the row grows to 44 px on coarse pointers. */
export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      data-slot="checkbox"
      className="relative flex items-center gap-s2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      <Radix.Root
        id={id}
        checked={checked}
        onCheckedChange={(state) => onChange(state === true)}
        disabled={disabled}
        className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-control-border bg-bg focus-ring disabled:opacity-50 state-checked:border-agent-fill state-checked:bg-agent-fill"
      >
        <Radix.Indicator className="text-agent-ink">
          <Icon icon={IconCheck} size={14} />
        </Radix.Indicator>
      </Radix.Root>
      <span className="text-ui text-fg">{label}</span>
    </label>
  );
}
