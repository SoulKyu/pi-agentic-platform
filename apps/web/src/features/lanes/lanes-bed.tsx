import { TooltipProvider } from "@pap/ui";
import type { ReactNode } from "react";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

export const current: { runtime: Runtime | undefined } = { runtime: undefined };

/** A fake runtime whose handlers the test sets per method; the lane features read it through `getRuntime`. */
export function newBed() {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  return bed;
}

/** Tooltips (icon buttons) need the provider main.tsx supplies. */
export const inShell = (children: ReactNode) => <TooltipProvider>{children}</TooltipProvider>;
