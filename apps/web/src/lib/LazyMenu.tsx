import type { MenuProps } from "@pap/ui/overlays";
import { useState, type ReactElement } from "react";
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
  const plain = trigger(() => setAsked(true));
  if (!asked) return plain;
  return (
    <LazyBoundary
      resetKey={attempt}
      fallback={plain}
      onError={(error) => {
        setAsked(false);
        retry();
        notifyLazyFailure(error, text);
      }}
    >
      <Lazy {...menu} defaultOpen trigger={plain} />
    </LazyBoundary>
  );
}
