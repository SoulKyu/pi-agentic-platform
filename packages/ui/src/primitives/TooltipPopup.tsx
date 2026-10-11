import { Tooltip as Radix } from "radix-ui";
import type { ReactElement } from "react";
import { Kbd } from "./Kbd.tsx";
import type { TooltipProps } from "./Tooltip.tsx";

/** The Radix half of Tooltip, loaded on first hover or focus (delayDuration 400, Orca STYLEGUIDE). */
export function TooltipPopup({
  label,
  shortcut,
  shortcutJoiner,
  side,
  children,
}: TooltipProps): ReactElement {
  return (
    <Radix.Provider delayDuration={400} skipDelayDuration={200}>
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
    </Radix.Provider>
  );
}
