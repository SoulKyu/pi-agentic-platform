import { AGENT_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { type PlatformHandler, PlatformRefusal } from "../platform/index.ts";

/** Calls one thread may make an hour (M11R239). */
export const NETWORK_REQUESTS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;

/**
 * `network.request` (owner a2, M11R239): whether the owner allowed this host for this thread, read from the daemon's own
 * grant record. The card itself is pi-host's approval question; a worker that skipped it gets `granted: false`.
 * 10 an hour per session, a fixed window on the kernel Clock.
 *
 * Spec boxes, task A7: the sessions of a project's box call it too (the daemon reads that from its own row, `boxOf`); a host
 * row that is not an agent thread is `forbidden`. A box session's answer is the owner's "Allow this host" (which put the host on
 * the project's list); a host the owner could not add because the list is full is `limit_reached`.
 */
export function createNetworkRequest(deps: {
  /** The daemon's record of the hosts the owner allowed (the sessions module's `HostGrants`). */
  readonly grants: { has(sessionId: string, host: string): boolean };
  /** The project box a session runs in and its list now, else null. */
  readonly boxOf?: (sessionId: string) => { readonly hosts: readonly string[] } | null;
  readonly clock: Pick<Clock, "now">;
}): PlatformHandler<"network.request"> {
  const windows = new Map<string, { startedAt: number; used: number }>();
  return (args, ctx) => {
    const box = ctx.type === "agent-thread" ? null : (deps.boxOf?.(ctx.sessionId) ?? null);
    if (ctx.type !== "agent-thread" && box === null) return Promise.reject(new PlatformRefusal("forbidden"));
    const now = deps.clock.now();
    for (const [id, window] of windows) if (now - window.startedAt >= HOUR_MS) windows.delete(id);
    const window = windows.get(ctx.sessionId) ?? { startedAt: now, used: 0 };
    windows.set(ctx.sessionId, window);
    if (window.used >= NETWORK_REQUESTS_PER_HOUR) return Promise.reject(new PlatformRefusal("rate_limited"));
    window.used++;
    const granted = deps.grants.has(ctx.sessionId, args.host);
    if (box !== null && !granted && !box.hosts.includes(args.host) && box.hosts.length >= AGENT_LIMITS.hosts)
      return Promise.reject(new PlatformRefusal("limit_reached"));
    return Promise.resolve({ granted });
  };
}
