import type { GuestClock } from "../guest.ts";
import type { NsDialer } from "./ns-dial.ts";
import type { NsDialer as ServiceNsDialer } from "./supervisor.ts";

/** A helper nobody has used for this long is stopped (a restarted service names a new namespace; the old helper goes then). */
export const NS_HELPER_IDLE_MS = 30_000;
/** Helpers alive at once: the service limit (SERVICE_LIMITS.perBox). A restart's old helper is idle and dropped for the new one. */
export const NS_HELPERS_MAX = 4;

export interface NsPoolDeps {
  readonly clock: GuestClock;
  /** `openNetns` on the real `/proc`: the namespace descriptor, or null when the pid changed under the check. */
  open(target: { pid: number; start: string }): number | null;
  /** Starts the helper inheriting `fd`; it has its own copy once this returns. */
  start(fd: number): NsDialer;
  closeFd(fd: number): void;
  log(line: string): void;
}

interface Entry {
  readonly dialer: NsDialer;
  users: number;
  idle: unknown;
}

/**
 * The supervisor asks for a dialer per connection and closes it with the connection (T5): this pool keeps one helper per
 * namespace (a pid with its start time) behind those handles, so a page of thirty requests is one node process, not thirty
 * (UX2-R22: about 40 MB per no-network service). The helper stops `NS_HELPER_IDLE_MS` after its last user; a dead one is
 * replaced at the next ask. The guest's own descriptor is closed as soon as the helper has started.
 */
export function createNsDialerPool(
  deps: NsPoolDeps,
): (target: { pid: number; start: string }) => ServiceNsDialer | null {
  const entries = new Map<string, Entry>();
  const drop = (key: string, entry: Entry): void => {
    if (entries.get(key) === entry) entries.delete(key);
    if (entry.idle !== undefined) deps.clock.clearTimeout(entry.idle);
    entry.idle = undefined;
    entry.dialer.close();
  };
  return (target) => {
    const key = `${target.pid}:${target.start}`;
    let entry = entries.get(key);
    if (entry !== undefined && !entry.dialer.alive()) {
      drop(key, entry);
      entry = undefined;
    }
    if (entry === undefined) {
      if (entries.size >= NS_HELPERS_MAX)
        for (const [other, idle] of [...entries]) if (idle.users === 0) drop(other, idle);
      if (entries.size >= NS_HELPERS_MAX) {
        deps.log("every namespace helper is in use");
        return null;
      }
      const fd = deps.open(target);
      if (fd === null) return null;
      try {
        entry = { dialer: deps.start(fd), users: 0, idle: undefined };
      } catch (error) {
        deps.log(`the namespace helper could not start (${error instanceof Error ? error.name : "error"})`);
        return null;
      } finally {
        deps.closeFd(fd);
      }
      entries.set(key, entry);
    }
    const held = entry;
    if (held.idle !== undefined) deps.clock.clearTimeout(held.idle);
    held.idle = undefined;
    held.users++;
    let released = false;
    return {
      connect(host, port) {
        if (host !== "127.0.0.1" && host !== "::1")
          return Promise.reject(new Error("only loopback is dialled"));
        return held.dialer.dial(host, port);
      },
      close() {
        if (released) return;
        released = true;
        if (--held.users > 0) return;
        held.idle = deps.clock.setTimeout(() => drop(key, held), NS_HELPER_IDLE_MS);
      },
    };
  };
}
