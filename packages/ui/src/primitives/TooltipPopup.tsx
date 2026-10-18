import { Tooltip as Radix } from "radix-ui";
import { forwardRef, useLayoutEffect, useState, type ReactElement, type Ref } from "react";
import { Kbd } from "./Kbd.tsx";
import type { TooltipProps } from "./Tooltip.tsx";

interface AdoptProps {
  readonly anchor: HTMLElement;
}

/**
 * Radix.Trigger hands its handlers, ref and state attributes to the element it wraps. The control already exists
 * and must keep its node, so this stand-in renders nothing and applies them to `anchor` instead.
 */
const Adopt = forwardRef<HTMLElement, AdoptProps>(function Adopt({ anchor, ...slot }, ref) {
  useLayoutEffect(() => {
    const setRef = ref as Ref<HTMLElement> | null;
    if (typeof setRef === "function") setRef(anchor);
    const removers: (() => void)[] = [];
    for (const [name, value] of Object.entries(slot as Record<string, unknown>)) {
      if (/^on[A-Z]/.test(name) && typeof value === "function") {
        const type = name.slice(2).toLowerCase();
        anchor.addEventListener(type, value as EventListener);
        removers.push(() => anchor.removeEventListener(type, value as EventListener));
      } else if (/^(data|aria)-/.test(name)) {
        if (typeof value === "string") anchor.setAttribute(name, value);
        else anchor.removeAttribute(name);
        removers.push(() => anchor.removeAttribute(name));
      }
    }
    return () => {
      for (const remove of removers) remove();
      if (typeof setRef === "function") setRef(null);
    };
  });
  return null;
});

function opensOnArrival(anchor: HTMLElement): boolean {
  try {
    return anchor.matches(":focus-visible");
  } catch {
    return document.activeElement === anchor;
  }
}

/** The Radix half of Tooltip, loaded on first hover or focus (delayDuration 400, Orca STYLEGUIDE). */
export function TooltipPopup({
  anchor,
  label,
  shortcut,
  shortcutJoiner,
  side,
}: Omit<TooltipProps, "children"> & { readonly anchor: HTMLElement }): ReactElement {
  const [startOpen] = useState(() => opensOnArrival(anchor)); // the control was focused before this loaded
  return (
    <Radix.Provider delayDuration={400} skipDelayDuration={200}>
      <Radix.Root defaultOpen={startOpen}>
        <Radix.Trigger asChild>
          <Adopt anchor={anchor} />
        </Radix.Trigger>
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
