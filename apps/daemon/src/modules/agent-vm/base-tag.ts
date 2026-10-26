import { PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";

/** The root-owned bundle changes only with `pap vm setup`: its digest is read again at most this often. */
export const BASE_TTL_MS = 3_600_000;
export const BASE_TAG_PREFIX = "pap-agent-base-";

/**
 * The base tag the installed bundle's bytes make, cached for `BASE_TTL_MS`. The digest runs off the event loop; callers that
 * arrive while it runs share it. A failure is logged and refused `sandbox_unavailable`, and is not cached.
 */
export function createBaseTag(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly digest: () => Promise<string>;
}): (fresh?: boolean) => Promise<string> {
  let cache: { tag: string; at: number } | null = null;
  let flight: Promise<string> | null = null;
  return (fresh = false) => {
    if (!fresh && cache !== null && deps.clock.now() - cache.at < BASE_TTL_MS)
      return Promise.resolve(cache.tag);
    flight ??= deps
      .digest()
      .then(
        (digest) => {
          const tag = `${BASE_TAG_PREFIX}${digest}`;
          cache = { tag, at: deps.clock.now() };
          return tag;
        },
        (error: unknown) => {
          deps.logger.warn("agent_vm_bundle_unreadable", { err: error });
          throw new PapError("sandbox_unavailable");
        },
      )
      .finally(() => void (flight = null));
    return flight;
  };
}
