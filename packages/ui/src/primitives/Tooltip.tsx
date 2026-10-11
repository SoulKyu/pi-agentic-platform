import { Tooltip as Radix } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { Kbd } from "./Kbd.tsx";

/** One provider at the app root (Orca STYLEGUIDE: delayDuration 400). */
export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return (
    <Radix.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </Radix.Provider>
  );
}

export interface TooltipProps {
  /** Names the control. A tooltip never teaches or warns (Orca STYLEGUIDE). */
  readonly label: string;
  readonly shortcut?: readonly string[];
  readonly shortcutJoiner?: "" | "+";
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly children: ReactElement;
}

// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Tooltip({ label, shortcut, shortcutJoiner, side, children }: TooltipProps) {
  return (
    <Radix.Root>
      <Radix.Trigger asChild>{children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          side={side ?? "top"}
          sideOffset={4}
          data-slot="tooltip"
          className="z-50 flex items-center gap-s1 rounded-sm border border-border-strong bg-bg-side px-s2 py-s1 text-ui text-fg shadow-overlay animate-overlay-in"
        >
          {label}
          {shortcut && shortcut.length > 0 ? <Kbd keys={shortcut} joiner={shortcutJoiner} /> : null}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
