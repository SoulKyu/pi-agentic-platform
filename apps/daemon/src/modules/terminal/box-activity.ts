import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { TerminalRegistry } from "./registry.ts";

/** The longest wait between two looks: a box with an attached terminal is touched at least this often. */
export const BOX_ACTIVITY_TICK_MS = 60_000;

export interface BoxActivity {
  /** Starts looking, if it is not (a box terminal was made or attached). */
  ensure(): void;
  stop(): void;
}

/**
 * Keeps a box awake while its terminals are in use (lot B2): a box with a browser stream attached to one of its terminals, or
 * whose terminal printed within the idle time, is touched (the runtime then waits its idle time from now). A terminal that is
 * detached and silent is not: the box idles out with it. It looks every third of the idle time at most, and only while a box
 * terminal runs; `idleMs` 0 (never idle out) needs no look.
 */
export function createBoxActivity(deps: {
  readonly clock: Clock;
  readonly idleMs: number;
  readonly registry: Pick<TerminalRegistry, "activeBoxes" | "boxShells">;
  touch(projectId: string): void;
}): BoxActivity {
  const { clock, idleMs, registry } = deps;
  const tickMs = Math.max(1, Math.min(Math.floor(idleMs / 3), BOX_ACTIVITY_TICK_MS));
  let timer: TimerHandle | undefined;

  const look = (): void => {
    timer = undefined;
    for (const projectId of registry.activeBoxes(idleMs)) deps.touch(projectId);
    if (registry.boxShells() > 0) timer = clock.setTimeout(look, tickMs);
  };

  return {
    ensure() {
      if (idleMs === 0 || timer !== undefined) return;
      timer = clock.setTimeout(look, tickMs);
    },
    stop() {
      if (timer) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
