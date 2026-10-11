import type { MenuProps } from "@pap/ui/overlays";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy, type LazyFailureText } from "./lazy.tsx";

// The menu stack (Radix dropdown, dialog sheet) is a chunk of its own, fetched on the first press of the trigger.
const loadMenu = () => import("@pap/ui/overlays").then((module) => ({ default: module.Menu }));

interface LazyMenuProps extends Omit<MenuProps, "trigger" | "defaultOpen"> {
  /** The plain trigger; `ask` is what its press calls to fetch the menu. */
  readonly trigger: (ask: () => void) => MenuProps["trigger"];
  readonly text: LazyFailureText;
}

/**
 * The one way the shell opens an overlay menu: the trigger alone until it is pressed, then the menu from its chunk,
 * open. A chunk that is gone leaves the trigger in place, says to reload, and the next press imports again.
 */
export function LazyMenu({ trigger, text, ...menu }: LazyMenuProps): ReactElement {
  const { Lazy, attempt, retry } = useRetryableLazy(loadMenu);
  const [asked, setAsked] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const refocus = useRef(false);
  // The trigger remounts when the menu fails to load; the person who pressed it keeps their place.
  useEffect(() => {
    if (asked || !refocus.current) return;
    refocus.current = false;
    box.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
  });
  const plain = trigger(() => setAsked(true));
  return (
    <span ref={box} className="contents">
      {asked ? (
        <LazyBoundary
          resetKey={attempt}
          fallback={plain}
          onError={(error) => {
            refocus.current = true;
            setAsked(false);
            retry();
            notifyLazyFailure(error, text);
          }}
        >
          <Lazy {...menu} defaultOpen trigger={plain} />
        </LazyBoundary>
      ) : (
        plain
      )}
    </span>
  );
}
