import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { overviewRpc, type OverviewRpc } from "./rpc.ts";
import { createOverviewSnapshot, type OverviewSources } from "./snapshot.ts";
import { createOverviewTicks } from "./ticks.ts";

export type { OverviewRpc } from "./rpc.ts";
export type { OverviewSources, OverviewUserFacts } from "./snapshot.ts";

export interface OverviewModule {
  readonly rpc: OverviewRpc;
  /** Something the Overview shows moved: every open viewer is ticked, at most once a second each (R2). */
  changed(): void;
  stop(): void;
}

/**
 * The Overview (decision 147): one bounded snapshot of the viewer's own boxes and the capacity band, and a payload-less
 * `overview` stream that says when to read it again. The daemon computes every word and figure; scoping rests on the auth
 * port's role (`roleOf`) inside the snapshot.
 */
export function createOverviewModule(
  deps: OverviewSources & {
    readonly clock: Clock;
    readonly logger: Logger;
    readonly hub: Pick<StreamHub, "publish" | "registerSnapshot" | "hasSubscribers" | "onLastSubscriberLeft">;
    /** Whether the VM stack is usable now (cached for a few seconds). */
    vmUsable(): Promise<boolean>;
  },
): OverviewModule {
  const build = createOverviewSnapshot(deps);
  const ticks = createOverviewTicks({ clock: deps.clock, hub: deps.hub, logger: deps.logger });
  return {
    rpc: overviewRpc({
      get: async (viewerId, scope) => build(viewerId, await deps.vmUsable(), scope),
      subscribe(viewerId, open) {
        ticks.open(viewerId);
        return open(viewerId);
      },
    }),
    changed: ticks.changed,
    stop: ticks.stop,
  };
}
