import type { Clock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { randomToken } from "../../../kernel/ids.ts";
import { enqueueEffect, type Outbox } from "../../../kernel/outbox/index.ts";
import type { PushNotifier } from "../service.ts";
import { cancelPending, insertEvent, liveEventByKey, liveEventExists } from "./events.ts";
import { clipName, DELIVERY, eventKey } from "./meta.ts";

/** Thrown inside the transaction to roll the event back when the outbox refuses the effect; never leaves `notify`. */
class OutboxRefused extends Error {}

/**
 * The one door of every source (M12R1). The event and its `push.send` effect are written in ONE transaction, so a
 * `pending` event never exists without its effect. The event's key is unique only while live; the outbox key carries
 * the event id, so a later push for the same ref is never swallowed by the outbox's 7 days of history.
 */
export function createNotifier(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly outbox: Pick<Outbox, "poke" | "cancel">;
  readonly readOnly: boolean;
  /** Tests: a fixed event id. */
  readonly newId?: () => string;
}): PushNotifier {
  const { db, clock, outbox } = deps;
  const newId = deps.newId ?? (() => randomToken(16));
  return {
    keyOf: (cls, refKind, refId) => eventKey(cls, refKind, refId),
    notify(event) {
      if (deps.readOnly) return null;
      const now = clock.now();
      const id = newId();
      const at = event.cls === "approval" ? now + DELIVERY.approvalDelayMs : (event.at ?? now);
      try {
        db.transaction(() => {
          // Checks first, writes after: inside an outer transaction the kernel has no savepoint, so a refusal must
          // leave nothing behind. Under the write lock nothing else can take the key between check and insert.
          const key = eventKey(event.cls, event.refKind, event.refId);
          if (liveEventExists(db, key)) throw new OutboxRefused();
          const queued = enqueueEffect(
            db,
            {
              kind: "push.send",
              ownerId: event.ownerId,
              payload: { eventId: id },
              dedupKey: `push.send:${id}`,
              at,
            },
            now,
          );
          if (queued === null) throw new OutboxRefused();
          const name = event.name === undefined ? "" : clipName(event.name);
          const inserted = insertEvent(db, {
            id,
            ownerId: event.ownerId,
            cls: event.cls,
            refKind: event.refKind,
            refId: event.refId,
            name: name === "" ? null : name,
            dedupKey: key,
            now,
          });
          if (!inserted) throw new Error("push_event_insert_raced");
        });
      } catch (error) {
        if (error instanceof OutboxRefused) return null;
        throw error;
      }
      outbox.poke();
      return { id };
    },
    cancel(refKey, reason) {
      if (deps.readOnly) return;
      const id = liveEventByKey(db, refKey);
      if (id === null) return;
      db.transaction(() => {
        outbox.cancel(`push.send:${id}`);
        cancelPending(db, id, reason, clock.now());
      });
    },
  };
}
