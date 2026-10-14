import { SessionLoadout, type SessionStreamEvent } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { RateLimiter } from "../../kernel/rate-limit.ts";

export interface LoadoutView {
  /** A worker's `loadout` record. The payload is the worker's text: parsed with the contract, never trusted (M7R44). */
  onRecord(raw: unknown): void;
  /** The last valid loadout; null until the worker says one. A worker that is gone takes its session out of the map with it. */
  current(): SessionLoadout | null;
}

export function createLoadoutView(deps: {
  readonly logger: Logger;
  readonly limiter: RateLimiter;
  publish(event: SessionStreamEvent): void;
}): LoadoutView {
  let loadout: SessionLoadout | null = null;
  let json = "";
  return {
    onRecord(raw) {
      const parsed = SessionLoadout.safeParse(raw);
      if (!parsed.success) {
        // Nothing of the record in the log: only that one was refused, and how many were left out meanwhile.
        const said = deps.limiter.check("loadout_invalid");
        if (said.allowed) deps.logger.warn("loadout_invalid", { suppressed: said.suppressed });
        return;
      }
      // An extension that loops on model changes must not turn each into an event nobody can see change.
      const next = JSON.stringify(parsed.data);
      if (next === json) return;
      json = next;
      loadout = parsed.data;
      deps.publish({ kind: "loadout", loadout });
    },
    current: () => loadout,
  };
}
