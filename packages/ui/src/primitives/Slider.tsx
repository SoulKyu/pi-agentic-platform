import { Slider as Radix } from "radix-ui";
import { useId } from "react";

export interface SliderProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  onChange(value: number): void;
  valueText(value: number): string;
}

/** A 2 px track with a square thumb (DESIGN.md §9.1). */
export function Slider({ label, value, min, max, step, onChange, valueText }: SliderProps) {
  const id = useId();
  return (
    <div data-slot="slider" className="flex flex-col gap-s1">
      <div className="flex items-baseline justify-between gap-s2">
        <span id={`${id}-label`} className="label-hud text-muted">
          {label}
        </span>
        <span className="font-mono text-ui tabular-nums text-muted">{valueText(value)}</span>
      </div>
      <Radix.Root
        value={[value]}
        min={min}
        max={max}
        step={step ?? 1}
        onValueChange={([next]) => {
          if (next !== undefined) onChange(next);
        }}
        className="relative flex h-5 w-full touch-none select-none items-center pointer-coarse:h-11"
      >
        <Radix.Track className="relative h-0.5 grow bg-surface-2">
          <Radix.Range className="absolute h-full bg-agent-fill" />
        </Radix.Track>
        <Radix.Thumb
          aria-labelledby={`${id}-label`}
          aria-valuetext={valueText(value)}
          className="block size-3 rounded-sm border border-agent-fill bg-bg focus-ring"
        />
      </Radix.Root>
    </div>
  );
}
