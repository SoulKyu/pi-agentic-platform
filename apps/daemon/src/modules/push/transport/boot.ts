import type { Clock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import type { Logger } from "../../../kernel/logger.ts";
import type { HostRule } from "./endpoint.ts";
import { createPushMeta } from "./meta.ts";
import { createSubscriptionStore, type Subscriptions } from "./store.ts";
import type { VapidState } from "./vapid.ts";

export interface TransportBootDeps {
  /** What `loadVapid` answered; null when the database is read-only and nothing was loaded. */
  readonly vapid: VapidState | null;
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hosts: readonly HostRule[];
  readonly loopbackForTests: boolean;
}

/**
 * Given the VAPID key `loadVapid` loaded (or minted), opens the subscription store and drops the rows made under another
 * key (M12R4). Such rows can never be decrypted by this key: that is a reset, or a plain restore without `secrets/`. It is
 * logged as a count and kept in `push_meta` for Settings until a device subscribes again. A damaged key file keeps push
 * off and touches nothing; so does a read-only database (`vapid` is then null). Runs after `prepareHome` and the
 * instance lock, before the server listens.
 */
export function bootTransport(deps: TransportBootDeps): Subscriptions {
  const keyId = deps.vapid?.kind === "ready" ? deps.vapid.identity.keyId : null;
  const subscriptions = createSubscriptionStore(deps.db, {
    clock: deps.clock,
    logger: deps.logger,
    keyId,
    hosts: deps.hosts,
    loopbackForTests: deps.loopbackForTests,
  });
  if (keyId === null) return subscriptions;
  const purged = deps.db.transaction(() => {
    const count = subscriptions.purgeForeignKeys(keyId);
    if (count > 0) createPushMeta(deps.db).setKeysReset({ at: deps.clock.now(), purged: count });
    return count;
  });
  if (purged > 0) deps.logger.warn("push_keys_reset", { purged });
  return subscriptions;
}
