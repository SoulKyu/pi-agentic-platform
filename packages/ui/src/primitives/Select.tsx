import { Select as Radix } from "radix-ui";
import { useId } from "react";
import { IconCheck, IconChevronDown } from "../icons.ts";
import { Icon } from "./Icon.tsx";

export interface Option<V extends string> {
  readonly value: V;
  readonly label: string;
}

export interface SelectProps<V extends string> {
  readonly label: string;
  readonly value: V;
  readonly options: readonly Option<V>[];
  onChange(value: V): void;
  readonly hint?: string;
  readonly disabled?: boolean;
}

const TRIGGER_CLASSES =
  "inline-flex h-control w-full items-center justify-between gap-s2 rounded-sm border border-control-border bg-bg px-s2 text-ui text-fg focus-ring disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:text-base";
const SCROLL_BUTTON_CLASSES = "flex h-control items-center justify-center text-muted pointer-coarse:min-h-11";
const ITEM_CLASSES =
  "relative flex h-control cursor-default select-none items-center gap-s2 rounded-sm px-s2 text-ui text-fg outline-none data-highlighted:bg-surface-2 pointer-coarse:min-h-11";

export function Select<V extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: SelectProps<V>) {
  const id = useId();
  return (
    <div data-slot="select" className="relative flex flex-col gap-s1">
      <span id={`${id}-label`} className="label-hud text-muted">
        {label}
      </span>
      <Radix.Root value={value} onValueChange={(next) => onChange(next as V)} disabled={disabled}>
        <Radix.Trigger
          aria-labelledby={`${id}-label`}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={TRIGGER_CLASSES}
        >
          <Radix.Value />
          <Radix.Icon>
            <Icon icon={IconChevronDown} size={14} />
          </Radix.Icon>
        </Radix.Trigger>
        <Radix.Portal>
          <Radix.Content
            position="popper"
            sideOffset={4}
            className="z-50 min-w-40 max-h-available overflow-hidden rounded-md border border-border-strong bg-bg-side p-s1 shadow-overlay animate-overlay-in"
          >
            <Radix.ScrollUpButton className={SCROLL_BUTTON_CLASSES}>
              <span className="rotate-180">
                <Icon icon={IconChevronDown} size={14} />
              </span>
            </Radix.ScrollUpButton>
            <Radix.Viewport data-slot="select-viewport">
              {options.map((option) => (
                <Radix.Item key={option.value} value={option.value} className={ITEM_CLASSES}>
                  <Radix.ItemText>{option.label}</Radix.ItemText>
                  <Radix.ItemIndicator className="ml-auto text-agent">
                    <Icon icon={IconCheck} size={14} />
                  </Radix.ItemIndicator>
                </Radix.Item>
              ))}
            </Radix.Viewport>
            <Radix.ScrollDownButton className={SCROLL_BUTTON_CLASSES}>
              <Icon icon={IconChevronDown} size={14} />
            </Radix.ScrollDownButton>
          </Radix.Content>
        </Radix.Portal>
      </Radix.Root>
      {hint ? (
        <span id={`${id}-hint`} className="text-ui text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
