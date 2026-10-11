import { Collapsible as Radix } from "radix-ui";
import type { ReactNode } from "react";

export interface CollapsibleProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** The trigger's content; the trigger itself is a full-width button that owns its look. */
  readonly trigger: ReactNode;
  readonly children: ReactNode;
}

/** ADR 0010 (S6, R53): the disclosure Reasoning and ToolCard need. */
export function Collapsible({ open, onOpenChange, trigger, children }: CollapsibleProps) {
  return (
    <Radix.Root open={open} onOpenChange={onOpenChange} data-slot="collapsible">
      <Radix.Trigger className="flex w-full items-center gap-s1 rounded-sm text-left focus-ring pointer-coarse:min-h-11">
        {trigger}
      </Radix.Trigger>
      <Radix.Content>{children}</Radix.Content>
    </Radix.Root>
  );
}
