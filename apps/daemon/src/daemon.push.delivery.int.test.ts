import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
import { openDatabase, type Db } from "./kernel/db/database.ts";
import { randomToken } from "./kernel/ids.ts";
import { enqueueEffect } from "./kernel/outbox/index.ts";
import { createFakeTransport, type FakeTransport } from "./modules/push/testing/fake-transport.ts";
import {
  createMemorySubscriptions,
  type MemorySubscriptions,
} from "./modules/push/testing/memory-subscriptions.ts";
import { startTestDaemon } from "./testing/harness.ts";
import type { SubscriptionTarget } from "./modules/push/index.ts";

const SCRIPT = { steps: [{ text: "unused" }] };
const OWNER = "u1";

let home: string;
let clock: FakeClock;
let transport: FakeTransport;
let subs: MemorySubscriptions;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-push-int-"));
  clock = createFakeClock();
  transport = createFakeTransport();
  subs = createMemorySubscriptions();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const target = (id: string): SubscriptionTarget => ({
  id,
  endpoint: `https://push.example.net/${id}`,
  p256dh: "p",
  auth: "a",
  credentialId: `c-${id}`,
  locale: "en",
});

function withDb<T>(work: (db: Db) => T): T {
  const db = openDatabase(join(home, "state.db"));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

/** A daemon life on `home` with the fake transport and clock injected through the compose seam. */
async function life<T>(work: () => Promise<T>): Promise<T> {
  const test = await startTestDaemon(SCRIPT, {
    config: { home },
    deps: { clock, push: { transport, subscriptions: subs, sessionLive: subs } },
  });
  try {
    return await work();
  } finally {
    await test.stop();
  }
}

/** Creates the database (a first boot), then writes a `failed` event and its effect while the daemon is stopped. */
async function seedEvent(): Promise<string> {
  await life(async () => undefined);
  const id = randomToken(16);
  withDb((db) =>
    db.transaction(() => {
      db.run(
        `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
         VALUES ($id, $owner, 'failed', 'session', 's1', 'push:failed:session:s1', 'pending', $now)`,
        { id, owner: OWNER, now: clock.now() },
      );
      enqueueEffect(
        db,
        { kind: "push.send", ownerId: OWNER, payload: { eventId: id }, dedupKey: `push.send:${id}` },
        clock.now(),
      );
    }),
  );
  return id;
}

const event = (id: string) =>
  withDb((db) =>
    db.get<{ state: string; reason: string | null }>("SELECT state, reason FROM push_events WHERE id = $id", {
      id,
    }),
  );
const deliveries = () =>
  withDb((db) =>
    db.all<{ sub_id: string; state: string; attempts: number }>(
      "SELECT sub_id, state, attempts FROM push_deliveries ORDER BY rowid",
    ),
  );
const outboxStatus = () =>
  withDb((db) => db.get<{ status: string }>("SELECT status FROM outbox WHERE kind = 'push.send'")?.status);
const settled = (check: () => unknown) => vi.waitFor(check, { timeout: 5000 });

describe("push.send through the real outbox", () => {
  it("survives a restart: the pending target is sent after recovery, a sent event is not sent again", async () => {
    subs.add(OWNER, target("a"));
    subs.add(OWNER, target("b"));
    const id = await seedEvent();
    transport.next({ kind: "ok" });
    transport.next({ kind: "retry" });

    await life(async () => {
      await clock.advance(0);
      await settled(() =>
        expect(deliveries()).toEqual([
          { sub_id: "a", state: "done", attempts: 0 },
          { sub_id: "b", state: "pending", attempts: 1 },
        ]),
      );
    });
    expect(event(id)?.state).toBe("pending");
    expect(outboxStatus()).toBe("pending");

    await life(async () => {
      await clock.advance(5_000);
      await settled(() => expect(event(id)?.state).toBe("sent"));
    });
    expect(transport.sent.map((c) => c.target.id)).toEqual(["a", "b", "b"]);
    expect(outboxStatus()).toBe("done");

    withDb((db) => db.run("UPDATE outbox SET status = 'pending', settled_at = NULL"));
    await life(async () => {
      await clock.advance(0);
      await settled(() => expect(outboxStatus()).toBe("done"));
    });
    expect(transport.sent).toHaveLength(3);
  });

  it("a signed-out session's subscription is dropped and nothing is sent", async () => {
    subs.add(OWNER, target("a"));
    subs.setSessionLive(false);
    const id = await seedEvent();
    await life(async () => {
      await clock.advance(0);
      await settled(() => expect(event(id)).toEqual({ state: "cancelled", reason: "no_target" }));
    });
    expect(transport.sent).toEqual([]);
    expect(subs.dropped).toEqual([{ id: "a", why: "dead_session" }]);
  });

  it("a 410 drops the row and the other device still gets the push", async () => {
    subs.add(OWNER, target("a"));
    subs.add(OWNER, target("b"));
    transport.next({ kind: "gone" });
    const id = await seedEvent();
    await life(async () => {
      await clock.advance(0);
      await settled(() => expect(event(id)?.state).toBe("sent"));
    });
    expect(subs.dropped).toEqual([{ id: "a", why: "gone" }]);
    expect(transport.sent.map((c) => c.target.id)).toEqual(["a", "b"]);
    expect(outboxStatus()).toBe("done");
  });
});
