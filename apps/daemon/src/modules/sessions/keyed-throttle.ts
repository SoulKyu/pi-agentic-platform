import type { SessionStreamEvent } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

export interface KeyedThrottleDeps {
  readonly clock: Clock;
  publish(event: SessionStreamEvent): void;
  readonly windowMs?: number;
  /** Keys with an open window at most; one more goes out at once, unthrottled. */
  readonly maxKeys?: number;
}

export interface KeyedThrottle {
  push(key: string, event: SessionStreamEvent): void;
  /** Sends what waits under `key` (every key without one) now and ends its window. */
  flush(key?: string): void;
  /** Forgets what waits under `key`, and its timer. */
  drop(key: string): void;
  /** Forgets everything and leaves no timer. */
  clear(): void;
}

interface Window {
  timer: TimerHandle;
  latest: SessionStreamEvent | null;
}

/**
 * M2R83. The first event of a key goes out at once and opens a window; later ones in the window replace each other and
 * go out, the latest only, when it ends (which opens the next window). A 60 Hz status therefore costs one publish per
 * window. The number of open windows is bounded, so a flood of distinct keys cannot grow the map or the timers.
 */
export function createKeyedThrottle(deps: KeyedThrottleDeps): KeyedThrottle {
  const { clock } = deps;
  const windowMs = deps.windowMs ?? 50;
  const maxKeys = deps.maxKeys ?? 64;
  const windows = new Map<string, Window>();

  function open(key: string): void {
    const timer = clock.setTimeout(() => {
      const window = windows.get(key);
      if (!window) return;
      const latest = window.latest;
      windows.delete(key);
      if (latest) {
        open(key);
        deps.publish(latest);
      }
    }, windowMs);
    windows.set(key, { timer, latest: null });
  }

  function end(key: string, window: Window): void {
    clock.clearTimeout(window.timer);
    windows.delete(key);
    if (window.latest) deps.publish(window.latest);
  }

  return {
    push(key, event) {
      const window = windows.get(key);
      if (window) {
        window.latest = event;
        return;
      }
      if (windows.size < maxKeys) open(key);
      deps.publish(event);
    },
    flush(key) {
      if (key !== undefined) {
        const window = windows.get(key);
        if (window) end(key, window);
        return;
      }
      for (const [name, window] of [...windows]) end(name, window);
    },
    drop(key) {
      const window = windows.get(key);
      if (!window) return;
      clock.clearTimeout(window.timer);
      windows.delete(key);
    },
    clear() {
      for (const window of windows.values()) clock.clearTimeout(window.timer);
      windows.clear();
    },
  };
}
