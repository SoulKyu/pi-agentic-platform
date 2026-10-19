import { GATEWAY_LIMITS } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

export interface ByteMeter {
  add(bytes: number): void;
  /** Cancels a pending resume (the connection closed). */
  stop(): void;
}

export interface GatewayLimits {
  /** A place among the connections waiting for a hello, or null (the total or the source's share is used up). Release it once. */
  admit(source: string): (() => void) | null;
  /** One connection's read window: past `windowBytes` per `windowMs` the socket is paused until the window turns. */
  meter(pause: () => void, resume: () => void): ByteMeter;
}

export function createGatewayLimits(clock: Clock): GatewayLimits {
  let waiting = 0;
  const bySource = new Map<string, number>();
  return {
    admit(source) {
      const mine = bySource.get(source) ?? 0;
      if (waiting >= GATEWAY_LIMITS.pendingTotal || mine >= GATEWAY_LIMITS.pendingPerSource) return null;
      waiting++;
      bySource.set(source, mine + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        waiting--;
        const left = (bySource.get(source) ?? 1) - 1;
        if (left <= 0) bySource.delete(source);
        else bySource.set(source, left);
      };
    },
    meter(pause, resume) {
      let windowStart = clock.now();
      let used = 0;
      let timer: TimerHandle | undefined;
      return {
        add(bytes) {
          const now = clock.now();
          if (timer === undefined && now - windowStart >= GATEWAY_LIMITS.windowMs) {
            windowStart = now;
            used = 0;
          }
          used += bytes;
          if (used <= GATEWAY_LIMITS.windowBytes || timer !== undefined) return;
          pause();
          timer = clock.setTimeout(
            () => {
              timer = undefined;
              windowStart = clock.now();
              used = 0;
              resume();
            },
            Math.max(0, windowStart + GATEWAY_LIMITS.windowMs - now),
          );
        },
        stop() {
          if (timer !== undefined) clock.clearTimeout(timer);
          timer = undefined;
        },
      };
    },
  };
}
