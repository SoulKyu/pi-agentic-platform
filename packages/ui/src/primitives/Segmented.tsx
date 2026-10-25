import { ToggleGroup } from "radix-ui";
import { useId } from "react";
import { cn } from "../cn.ts";
import type { Option } from "./Select.tsx";

const ITEM_CLASSES =
  "h-control border-b-2 border-transparent px-s2 label-hud text-muted transition-colors duration-fast focus-ring can-hover:hover:text-fg state-on:border-agent state-on:text-fg pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export interface SegmentedProps<V extends string> {
  readonly label: string;
  /** The label stays for screen readers only, when the surrounding text already names the control. */
  readonly labelHidden?: boolean;
  readonly value: V;
  readonly options: readonly Option<V>[];
  onChange(value: V): void;
}

/** Mono upper-case items; the active one gets an agent underline (DESIGN.md §9.1). One value is always selected. */
export function Segmented<V extends string>({
  label,
  labelHidden,
  value,
  options,
  onChange,
}: SegmentedProps<V>) {
  const labelId = useId();
  return (
    <div data-slot="segmented-field" className="inline-flex flex-col gap-s1">
      <span id={labelId} className={cn("label-hud text-muted", labelHidden && "sr-only")}>
        {label}
      </span>
      <ToggleGroup.Root
        type="single"
        value={value}
        aria-labelledby={labelId}
        onValueChange={(next) => {
          if (next !== "") onChange(next as V);
        }}
        data-slot="segmented"
        className="inline-flex items-center gap-s1 border-b border-border"
      >
        {options.map((option) => (
          <ToggleGroup.Item key={option.value} value={option.value} className={ITEM_CLASSES}>
            {option.label}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </div>
  );
}
