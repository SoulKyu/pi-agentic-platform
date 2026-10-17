import type { Clock } from "../../kernel/clock.ts";
import { type PlatformHandler, PlatformRefusal } from "../platform/index.ts";

/** Calls one thread may make an hour (M11R239). */
export const NETWORK_REQUESTS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;

/**
 * `network.request` (owner a2, M11R239): whether the owner allowed this host for this thread, read from the daemon's own
 * grant record. The card itself is pi-host's approval question; a worker that skipped it gets `granted: false`.
 * 10 an hour per thread, a fixed window on the kernel Clock.
 */
export function createNetworkRequest(deps: {
  /** The daemon's record of the hosts the owner allowed (the sessions module's `HostGrants`). */
  readonly grants: { has(sessionId: string, host: string): boolean };
  readonly clock: Pick<Clock, "now">;
}): PlatformHandler<"network.request"> {
  const windows = new Map<string, { startedAt: number; used: number }>();
  return (args, ctx) => {
    const now = deps.clock.now();
    for (const [id, window] of windows) if (now - window.startedAt >= HOUR_MS) windows.delete(id);
    const window = windows.get(ctx.sessionId) ?? { startedAt: now, used: 0 };
    windows.set(ctx.sessionId, window);
    if (window.used >= NETWORK_REQUESTS_PER_HOUR) return Promise.reject(new PlatformRefusal("rate_limited"));
    window.used++;
    return Promise.resolve({ granted: deps.grants.has(ctx.sessionId, args.host) });
  };
}
