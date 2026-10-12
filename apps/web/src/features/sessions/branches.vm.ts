import type { ForkPoint } from "@pap/contracts";

export interface BranchChoices {
  /** 1-based place of the row among its siblings. */
  readonly index: number;
  readonly total: number;
  /** The leaf a switch to the previous / next sibling goes to; absent at either end. */
  readonly previous?: string;
  readonly next?: string;
}

/** Where a user row stands among the choices of its fork point; null when it is not one of two or more siblings. */
export function branchChoicesFor(points: readonly ForkPoint[], entryId: string): BranchChoices | null {
  for (const { choices } of points) {
    const at = choices.findIndex((choice) => choice.entryId === entryId);
    if (at < 0 || choices.length < 2) continue;
    const previous = choices[at - 1]?.target;
    const next = choices[at + 1]?.target;
    return {
      index: at + 1,
      total: choices.length,
      ...(previous === undefined ? {} : { previous }),
      ...(next === undefined ? {} : { next }),
    };
  }
  return null;
}
