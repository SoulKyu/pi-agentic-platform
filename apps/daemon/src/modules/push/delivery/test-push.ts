import { PapError, PushWire, type Caller } from "@pap/contracts";
import type { Clock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { randomToken } from "../../../kernel/ids.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { createRateLimiter } from "../../../kernel/rate-limit.ts";
import { requireBrowser, type PushTransport, type SendOutcome, type SubscriptionsPort } from "../service.ts";
import { copyFor } from "./copy.ts";
import { clearLastFailure, insertEvent, settleEvent } from "./events.ts";
import { eventKey } from "./meta.ts";

export type TestPush = (caller: Caller) => Promise<{ delivered: number; dropped: number }>;

const LIMIT_MS = 10_000;
const DEADLINE_MS = 15_000;

/**
 * `push.test` (M12R9, M12R10): the owner presses a button in Settings > Notifications and this browser's own devices
 * get a `test` push, straight through the transport (no outbox, no retry: the answer is the result). A browser only,
 * one call per 10 s per owner. A `test` event row gives the click somewhere to land (Settings > Notifications).
 */
export function createTestPush(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly transport: Pick<PushTransport, "status" | "send">;
  readonly subscriptions: Pick<SubscriptionsPort, "targets" | "drop" | "markOk">;
}): TestPush {
  const { db, clock, logger } = deps;
  const limiter = createRateLimiter(clock, LIMIT_MS);
  return async (caller) => {
    requireBrowser(caller);
    if (!deps.transport.status().on) throw new PapError("push_unavailable");
    if (!limiter.check(caller.userId).allowed) throw new PapError("rate_limited");

    const id = randomToken(16);
    const now = clock.now();
    insertEvent(db, {
      id,
      ownerId: caller.userId,
      cls: "test",
      refKind: "test",
      refId: id,
      name: null,
      dedupKey: eventKey("test", "test", id),
      now,
    });
    const targets = deps.subscriptions.targets(caller.userId, caller.credentialId);
    const abort = new AbortController();
    const timer = clock.setTimeout(() => abort.abort(), DEADLINE_MS);
    let delivered = 0;
    let dropped = 0;
    try {
      await Promise.all(
        targets.map(async (target) => {
          const { title, body } = copyFor("test", target.locale);
          const wire = PushWire.parse({ v: 1, id, cls: "test", title, body, ts: now });
          const outcome = await deps.transport
            .send(
              target,
              new TextEncoder().encode(JSON.stringify(wire)),
              { ttlSeconds: 3600, urgency: "normal", topic: id },
              abort.signal,
            )
            .catch((error: unknown): SendOutcome => {
              logger.warn("push_test_transport_threw", {
                errorClass: error instanceof Error ? error.name : typeof error,
              });
              return { kind: "retry" };
            });
          if (outcome.kind === "ok") {
            deps.subscriptions.markOk(target.id, clock.now());
            delivered++;
          } else if (outcome.kind === "gone") {
            deps.subscriptions.drop(target.id, "gone");
            dropped++;
          }
        }),
      );
    } finally {
      clock.clearTimeout(timer);
    }
    if (targets.length === 0) settleEvent(db, id, "cancelled", "no_target", clock.now());
    else if (delivered > 0) {
      settleEvent(db, id, "sent", null, clock.now());
      clearLastFailure(db, caller.userId); // a working device ends the old failure line
    } else settleEvent(db, id, "failed", dropped > 0 ? "gone" : "undelivered", clock.now());
    return { delivered, dropped };
  };
}
