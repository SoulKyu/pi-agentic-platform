import type { PopoverProps } from "@pap/ui/overlays";
import { useState, type ReactElement } from "react";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy, type LazyFailureText } from "./lazy.tsx";

// The popover stack (Radix popover, the phone sheet's dialog) sits in the overlays chunk, fetched on the first press.
const loadPopover = () => import("@pap/ui/overlays").then((module) => ({ default: module.Popover }));

interface LazyPopoverProps extends Omit<PopoverProps, "trigger"> {
  /** The plain trigger; `ask` is what its press calls to fetch the popover. */
  readonly trigger: (ask: () => void) => PopoverProps["trigger"];
  readonly text: LazyFailureText;
}

/**
 * `LazyMenu` for a popover whose open state the owner holds: the trigger alone until it is pressed, then the popover
 * from its chunk. The first press asks for the chunk and opens (`onOpenChange(true)`); later presses are the popover's
 * own. A chunk that is gone closes it, says to reload, and the next press imports again.
 */
export function LazyPopover({ trigger, text, onOpenChange, ...popover }: LazyPopoverProps): ReactElement {
  const { Lazy, attempt, retry } = useRetryableLazy(loadPopover);
  const [asked, setAsked] = useState(false);
  const plain = trigger(() => {
    if (asked) return;
    setAsked(true);
    onOpenChange(true);
  });
  if (!asked) return plain;
  return (
    <LazyBoundary
      resetKey={attempt}
      fallback={plain}
      onError={(error) => {
        setAsked(false);
        onOpenChange(false);
        retry();
        notifyLazyFailure(error, text);
      }}
    >
      <Lazy {...popover} onOpenChange={onOpenChange} trigger={plain} />
    </LazyBoundary>
  );
}
