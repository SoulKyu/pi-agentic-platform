import { PushWire, type NotificationsSettings, type WireClass } from "@pap/contracts";
import type { Clock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import type { Logger } from "../../../kernel/logger.ts";
import type { EffectContext, Settlement } from "../../../kernel/outbox/index.ts";
import type {
  PushPresence,
  PushTransport,
  SendOutcome,
  SessionLive,
  SubscriptionsPort,
  SubscriptionTarget,
} from "../service.ts";
import { endpointTag } from "../endpoint-tag.ts";
import { copyFor } from "./copy.ts";
import { decide } from "./decide.ts";
import { digestCounts } from "./digest.ts";
import {
  dueDeliveries,
  earliestPending,
  hasDeliveries,
  insertDeliveries,
  retryDelivery,
  settleDelivery,
  summarize,
  type DeliveryRow,
} from "./deliveries.ts";
import {
  bumpRechecks,
  countSentSince,
  loadEvent,
  clearLastFailure,
  recordLastFailure,
  settleEvent,
  type EventRow,
} from "./events.ts";
import { DELIVERY, type EventClass } from "./meta.ts";

/** Everything `push.send` reads: the ports of the two chains and the live inputs of the rules (M12R3). */
export interface SendDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly transport: Pick<PushTransport, "send" | "status">;
  readonly subscriptions: SubscriptionsPort;
  readonly sessionLive: SessionLive;
  readonly presence: Pick<PushPresence, "looking">;
  readonly cooldown: { free(key: string): boolean; reserve(key: string): boolean };
  readonly notifications: (ownerId: string) => NotificationsSettings;
  /** Whether the owner's quiet hours cover `at`. */
  readonly quiet: (ownerId: string, at: number) => boolean;
  /** An event was held: queues the digest for the end of the quiet window. Runs in the transaction that settles the event `held`. */
  readonly onHold: (ownerId: string, at: number) => void;
  /** The source still has the thing waiting (M12R23): an answered approval, a resolved Inbox item say no. */
  readonly stillWaiting: (event: EventRow) => boolean;
}

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;
const RETRY_AFTER_MAX_MS = 3_600_000;
const DONE: Settlement = { outcome: "done" };

/** Urgency and TTL per class: no longer than the item's useful life (M12-RT-22); iOS defers anything below `normal`. */
const POLICY: Record<WireClass, { urgency: "normal" | "high"; ttlSeconds: number }> = {
  approval: { urgency: "high", ttlSeconds: 3600 },
  failed: { urgency: "high", ttlSeconds: 14_400 },
  budget: { urgency: "high", ttlSeconds: 14_400 },
  notify: { urgency: "normal", ttlSeconds: 14_400 },
  done: { urgency: "normal", ttlSeconds: 3600 },
  reply: { urgency: "normal", ttlSeconds: 3600 },
  review: { urgency: "normal", ttlSeconds: 3600 },
  digest: { urgency: "normal", ttlSeconds: 14_400 },
  test: { urgency: "normal", ttlSeconds: 3600 },
};

/** A transport's reason is logged only when it looks like a class; anything else could carry a URL. */
const reasonClass = (reason: string): string => (/^[a-z_]{1,40}$/.test(reason) ? reason : "other");

/**
 * The `push.send` handler (M12R13). It never calls `markSent` and never throws: a duplicate after a crash is collapsed
 * by `Topic` and `tag`, and is better than a lost approval. Per-device state lives in `push_deliveries`, so a replay
 * resumes the pending targets only. A 429, a 5xx or a timeout is retried up to five times, never a first-try failure.
 */
export function createPushSend(deps: SendDeps) {
  return async (payload: { eventId: string }, ctx: EffectContext): Promise<Settlement> => {
    try {
      return await run(deps, payload.eventId, ctx);
    } catch (error) {
      // An exception would reach the outbox's own log with its message, and a URL error carries the endpoint.
      deps.logger.error("push_send_error", {
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      return { outcome: "retry", code: "push_error" };
    }
  };
}

async function run(deps: SendDeps, eventId: string, ctx: EffectContext): Promise<Settlement> {
  const { db, clock } = deps;
  const event = loadEvent(db, eventId);
  if (!event) return DONE;
  const now = clock.now();
  if (event.state === "held") {
    // A replay of the effect that held it: the digest is re-ensured (idempotent by its key), nothing else happens.
    db.transaction(() => deps.onHold(event.ownerId, now));
    return DONE;
  }
  if (event.state !== "pending") return DONE;
  if (ctx.cancelRequested()) return cancel(deps, event, "cancelled");
  // A digest and a test are about no source: nothing "still waits" for them.
  const ownRef = event.cls === "digest" || event.cls === "test";
  // Neutral reason: the source says it is over, which is an answer, a withdrawal or a worker that died.
  if (!ownRef && !deps.stillWaiting(event)) return cancel(deps, event, "gone");

  if (!hasDeliveries(db, eventId)) {
    const early = begin(deps, event, now);
    if (early) return early;
  }

  const live = new Map(deps.subscriptions.targets(event.ownerId).map((t) => [t.id, t]));
  const due = dueDeliveries(db, eventId, now);
  // Every send ends (or is aborted) before this returns, so a throwing one never leaves others in flight.
  const passes = await Promise.allSettled(
    due.map((delivery) => deliver(deps, event, delivery, live.get(delivery.subId), ctx)),
  );
  const broken = passes.find((pass) => pass.status === "rejected");
  if (broken) throw (broken as PromiseRejectedResult).reason;

  const next = earliestPending(db, eventId);
  if (next !== null) return { outcome: "defer", until: next };
  return finish(deps, event);
}

function cancel(deps: SendDeps, event: EventRow, reason: string): Settlement {
  settleEvent(deps.db, event.id, "cancelled", reason, deps.clock.now());
  return DONE;
}

/** The first run of an event: the rules, then the targets. Returns the settlement when the event ends or waits here. */
function begin(deps: SendDeps, event: EventRow, now: number): Settlement | null {
  const { db } = deps;
  const decision = decide({
    cls: event.cls as EventClass,
    now,
    settings: deps.notifications(event.ownerId),
    quiet: deps.quiet(event.ownerId, now),
    looking: deps.presence.looking(event.ownerId),
    cooldownFree: deps.cooldown.free(event.dedupKey),
    hourCount: countSentSince(db, event.ownerId, now - DELIVERY.hourMs),
    rechecks: event.rechecks,
  });
  if (decision.action === "suppress") {
    settleEvent(db, event.id, "suppressed", decision.reason, now);
    return DONE;
  }
  if (decision.action === "hold") {
    // One transaction: a held event without its digest would be lost for good.
    db.transaction(() => {
      settleEvent(db, event.id, "held", null, now);
      deps.onHold(event.ownerId, now);
    });
    return DONE;
  }
  if (decision.action === "recheck") {
    bumpRechecks(db, event.id);
    return { outcome: "defer", until: now + decision.afterMs };
  }
  // Push is off (no key, or no HTTPS) while old rows exist: nothing could be sent, and that is not a delivery failure.
  if (!deps.transport.status().on) {
    settleEvent(db, event.id, "cancelled", "push_off", now);
    return DONE;
  }
  // Only a push that goes out takes the window: a cap or a hold never consumes it.
  if (!event.cls.match(/^(digest|test)$/)) deps.cooldown.reserve(event.dedupKey);
  const known = deps.subscriptions.targets(event.ownerId);
  const targets = known.filter((target) => liveOrDrop(deps, event.ownerId, target));
  if (targets.length === 0) {
    settleEvent(db, event.id, "cancelled", "no_target", now);
    // An owner who never enabled push has no failure to show (W6-R6); one whose devices all died does.
    if (known.length === 0) return DONE;
    recordLastFailure(db, event.ownerId, "no_target", now);
    return DONE;
  }
  insertDeliveries(
    db,
    event.id,
    targets.map((target) => target.id),
    now,
  );
  return null;
}

/** A subscription whose browser session is gone keeps its row until now: it is dropped and never sent to (M12R12). */
function liveOrDrop(deps: SendDeps, ownerId: string, target: SubscriptionTarget): boolean {
  if (deps.sessionLive.sessionLive(ownerId, target.credentialId)) return true;
  deps.subscriptions.drop(target.id, "dead_session"); // the store logs the drop
  return false;
}

async function deliver(
  deps: SendDeps,
  event: EventRow,
  delivery: DeliveryRow,
  target: SubscriptionTarget | undefined,
  ctx: EffectContext,
): Promise<void> {
  const { db, clock } = deps;
  if (!target) return settleDelivery(db, event.id, delivery.subId, "gone", "removed");
  if (!liveOrDrop(deps, event.ownerId, target))
    return settleDelivery(db, event.id, delivery.subId, "gone", "dead_session");
  const outcome = await deps.transport
    .send(
      target,
      plaintext(deps, event, target),
      { ...POLICY[event.cls as WireClass], topic: event.id },
      ctx.signal,
    )
    .catch((error: unknown): SendOutcome => {
      deps.logger.warn("push_transport_threw", {
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      return { kind: "retry" };
    });
  const tag = endpointTag(target.endpoint);
  const now = clock.now();
  // A port that answers outside its type is refused, not retried at once: the row would otherwise stay due forever.
  const refuseUnknown = () => {
    deps.logger.warn("push_delivery_failed", { target: tag, reason: "refused", why: "other" });
    return settleDelivery(db, event.id, delivery.subId, "failed", "refused");
  };
  if (typeof outcome !== "object" || outcome === null) return refuseUnknown();
  switch (outcome.kind) {
    case "ok":
      deps.subscriptions.markOk(target.id, now);
      return settleDelivery(db, event.id, delivery.subId, "done", null);
    case "gone":
      deps.subscriptions.drop(target.id, "gone"); // the store logs the drop
      return settleDelivery(db, event.id, delivery.subId, "gone", "gone");
    case "retry": {
      const attempts = delivery.attempts + 1;
      const after =
        typeof outcome.afterMs === "number" && Number.isFinite(outcome.afterMs) ? outcome.afterMs : 0;
      const wait = Math.max(
        BACKOFF_BASE_MS * 2 ** (attempts - 1),
        Math.min(Math.max(0, Math.ceil(after)), RETRY_AFTER_MAX_MS),
      );
      retryDelivery(db, event.id, delivery.subId, attempts, now + wait);
      if (attempts < MAX_ATTEMPTS) return;
      deps.logger.warn("push_delivery_failed", { target: tag, reason: "retry_exhausted" });
      return settleDelivery(db, event.id, delivery.subId, "failed", "retry_exhausted");
    }
    case "rejected":
      deps.logger.warn("push_delivery_failed", { target: tag, reason: "rejected", status: outcome.status });
      return settleDelivery(db, event.id, delivery.subId, "failed", "rejected");
    case "refused":
      deps.logger.warn("push_delivery_failed", {
        target: tag,
        reason: "refused",
        why: reasonClass(outcome.reason),
      });
      return settleDelivery(db, event.id, delivery.subId, "failed", "refused");
    default: {
      const unreachable: never = outcome;
      void unreachable;
      return refuseUnknown();
    }
  }
}

/** The wire payload (M12R7): generic text and the opaque id; a registry name only when the owner chose `names`. */
function plaintext(deps: SendDeps, event: EventRow, target: SubscriptionTarget): Uint8Array {
  const names = deps.notifications(event.ownerId).titles === "names" && event.name !== null;
  const cls = PushWire.shape.cls.parse(event.cls);
  const extra =
    cls === "digest" ? digestCounts(deps.db, event.id) : names ? { name: event.name ?? undefined } : {};
  const { title, body } = copyFor(cls, target.locale, extra);
  const wire = PushWire.parse({ v: 1, id: event.id, cls, title, body, ts: deps.clock.now() });
  return new TextEncoder().encode(JSON.stringify(wire));
}

/** Every delivery is final: `sent` if any target got it, `failed` with a class if one was refused, else nobody was left. */
function finish(deps: SendDeps, event: EventRow): Settlement {
  const { db } = deps;
  const now = deps.clock.now();
  const result = summarize(db, event.id);
  if (result.done > 0) {
    settleEvent(db, event.id, "sent", null, now);
    clearLastFailure(db, event.ownerId); // Settings shows a failure only until the next success
  } else if (result.failed > 0) {
    const reason = result.firstFailure ?? "failed";
    settleEvent(db, event.id, "failed", reason, now);
    recordLastFailure(db, event.ownerId, reason, now);
  } else {
    settleEvent(db, event.id, "cancelled", "no_target", now);
    recordLastFailure(db, event.ownerId, "no_target", now);
  }
  return DONE;
}
