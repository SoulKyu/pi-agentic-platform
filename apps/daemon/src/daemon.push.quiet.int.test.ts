import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationSettings, PushWire } from "@pap/contracts";
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
import type { SubscriptionTarget } from "./modules/push/index.ts";
import { startTestDaemon } from "./testing/harness.ts";

const SCRIPT = { steps: [{ text: "unused" }] };
const OWNER = "u1";
/** The fake clock starts at 23:13 in Paris; the window 22:00-07:00 ends at 06:00Z the next day. */
const TO_MORNING_MS = 28_000_000;

let home: string;
let clock: FakeClock;
let transport: FakeTransport;
let subs: MemorySubscriptions;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-push-quiet-int-"));
  clock = createFakeClock();
  transport = createFakeTransport();
  subs = createMemorySubscriptions();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const device: SubscriptionTarget = {
  id: "a",
  endpoint: "https://push.example.net/a",
  p256dh: "p",
  auth: "a",
  credentialId: "c-a",
  locale: "fr",
};

function withDb<T>(work: (db: Db) => T): T {
  const db = openDatabase(join(home, "state.db"));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

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

/** Creates the database, then writes the owner's quiet hours and three `failed` events with their effects. */
async function seed(): Promise<void> {
  await life(async () => undefined);
  withDb((db) =>
    db.transaction(() => {
      const quiet = AutomationSettings.parse({
        quietHours: { from: "22:00", to: "07:00" },
        timezone: "Europe/Paris",
      });
      db.run(
        "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ($owner, 'automation', $value, 1, $now)",
        { owner: OWNER, value: JSON.stringify(quiet), now: clock.now() },
      );
      for (const ref of ["s1", "s2", "s3"]) {
        const id = randomToken(16);
        db.run(
          `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
           VALUES ($id, $owner, 'failed', 'session', $ref, $key, 'pending', $now)`,
          { id, owner: OWNER, ref, key: `push:failed:session:${ref}`, now: clock.now() },
        );
        enqueueEffect(
          db,
          { kind: "push.send", ownerId: OWNER, payload: { eventId: id }, dedupKey: `push.send:${id}` },
          clock.now(),
        );
      }
    }),
  );
}

const states = () =>
  withDb((db) =>
    db
      .all<{ cls: string; state: string }>("SELECT cls, state FROM push_events ORDER BY created_at, rowid")
      .map((row) => `${row.cls}:${row.state}`),
  );
const settled = (check: () => unknown) => vi.waitFor(check, { timeout: 5000 });

describe("quiet hours through the real outbox", () => {
  it("holds three events and sends one digest at the end of the window, across a restart", async () => {
    subs.add(OWNER, device);
    await seed();

    await life(async () => {
      await clock.advance(0);
      await settled(() => expect(states()).toEqual(["failed:held", "failed:held", "failed:held"]));
    });
    expect(transport.sent).toEqual([]);
    expect(
      withDb((db) => db.all<{ next_at: number }>("SELECT next_at FROM outbox WHERE kind = 'digest.send'")),
    ).toEqual([{ next_at: 1_700_000_000_000 + TO_MORNING_MS }]);

    await life(async () => {
      await clock.advance(TO_MORNING_MS);
      await settled(() => expect(states()).toContain("digest:sent"));
    });
    expect(states()).toEqual(["failed:digested", "failed:digested", "failed:digested", "digest:sent"]);
    expect(transport.sent).toHaveLength(1);
    const wire = PushWire.parse(JSON.parse(new TextDecoder().decode(transport.sent[0]?.plaintext)));
    expect(wire).toMatchObject({ cls: "digest", body: "3 éléments vous attendent." });
    expect(
      withDb((db) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'")),
    ).toEqual({ n: 0 });
  });
});
