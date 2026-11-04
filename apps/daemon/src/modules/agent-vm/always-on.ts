import { type BoxRef, boxKey, PapError } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";

export interface AlwaysOnBox {
  readonly box: BoxRef;
  readonly ownerId: string;
}

export interface AlwaysOnKeeperDeps {
  /** The boxes that must be up now, in start order (R3), without the ones to skip (R4). Read live. */
  boxes(): readonly AlwaysOnBox[];
  start(entry: AlwaysOnBox): Promise<void>;
  readonly logger: Pick<Logger, "warn">;
}

/**
 * The always-on keeper (decision 149): starts the listed boxes when pap starts, one at a time, and again after an unasked
 * exit. A refused start is logged once and never retried; the box starts at its next message, task, START or pap start.
 */
export function createAlwaysOnKeeper(deps: AlwaysOnKeeperDeps) {
  let holdFailureLogged = false;
  let closed = false;

  const listed = (): readonly AlwaysOnBox[] => {
    try {
      return deps.boxes();
    } catch (error) {
      if (!holdFailureLogged) {
        holdFailureLogged = true;
        deps.logger.warn("always_on_hold_failed", { err: error });
      }
      return [];
    }
  };

  const startOne = async (entry: AlwaysOnBox): Promise<void> => {
    try {
      await deps.start(entry);
    } catch (error) {
      const code = error instanceof PapError ? error.code : "internal";
      deps.logger.warn("always_on_start_refused", { box: boxKey(entry.box), code });
    }
  };

  const find = (box: BoxRef) => listed().find((entry) => boxKey(entry.box) === boxKey(box));

  return {
    async bootStart(): Promise<void> {
      for (const entry of listed()) {
        if (closed) return;
        await startOne(entry);
      }
    },
    /** Shutdown began: no box is started from now on, and an exit is not answered. */
    close(): void {
      closed = true;
    },
    exited(box: BoxRef): void {
      if (closed) return;
      const entry = find(box);
      if (entry !== undefined) void startOne(entry);
    },
    holds: (box: BoxRef): boolean => find(box) !== undefined,
  };
}
