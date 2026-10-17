import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationSettings, PushWire } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
import { openDatabase, type Db } from "./kernel/db/database.ts";
import { randomToken } from "./kernel/ids.ts";
import { enqueueEffect } from "./kernel/outbox/index.ts";
import type { SubscriptionTarget } from "./modules/push/index.ts";
import { createFakeTransport, type FakeTransport } from "./modules/push/testing/fake-transport.ts";
import {
  createMemorySubscriptions,
  type MemorySubscriptions,
} from "./modules/push/testing/memory-subscriptions.ts";
import { startTestDaemon } from "./testing/harness.ts";

const SCRIPT = { steps: [{ text: "unused" }] };
const OWNER = "u1";
const AGENT = "atlas-1a2b";
/** The fake clock starts at 23:13 in Paris; the window 22:00-07:00 ends at 06:00Z the next day. */
const TO_MORNING_MS = 28_000_000;

let home: string;
let clock: FakeClock;
let transport: FakeTransport;
let subs: MemorySubscriptions;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-push-inbox-int-"));
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

interface Seeded {
  readonly kind: string;
  readonly cls: string;
  readonly resolution: "answered" | "timed_out" | null;
  readonly open: boolean;
}

/** The Inbox items of four requests and the push each one raised; all open when the night starts, two close while held. */
const SEEDS: Record<string, Seeded> = {
  waiting: { kind: "agent_approve", cls: "approval", resolution: null, open: true },
  answered: { kind: "agent_approve", cls: "approval", resolution: "answered", open: false },
  timedOut: { kind: "secret_request", cls: "approval", resolution: "timed_out", open: false },
  news: { kind: "agent_notify", cls: "notify", resolution: null, open: true },
};

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
      for (const [name, item] of Object.entries(SEEDS)) {
        db.run(
          `INSERT INTO inbox_items (id, owner_id, kind, to_handle, title, created_at, agent_id, ref_id, resolved_at, resolution)
           VALUES ($id, $owner, $kind, $toHandle, 'agent', $now, $agent, $id, $resolvedAt, $resolution)`,
          {
            id: name,
            owner: OWNER,
            kind: item.kind,
            toHandle: item.cls === "approval" ? 1 : 0,
            now: clock.now(),
            agent: AGENT,
            resolvedAt: null,
            resolution: null,
          },
        );
        const eventId = randomToken(16);
        db.run(
          `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
           VALUES ($eventId, $owner, $cls, 'inbox', $id, $key, 'pending', $now)`,
          {
            eventId,
            owner: OWNER,
            cls: item.cls,
            id: name,
            key: `push:${item.cls}:inbox:${name}`,
            now: clock.now(),
          },
        );
        enqueueEffect(
          db,
          { kind: "push.send", ownerId: OWNER, payload: { eventId }, dedupKey: `push.send:${eventId}` },
          clock.now(),
        );
      }
    }),
  );
}

const states = () =>
  withDb((db) =>
    db
      .all<{ ref_id: string; state: string; reason: string | null }>(
        "SELECT ref_id, state, reason FROM push_events WHERE cls <> 'digest' ORDER BY ref_id",
      )
      .map((row) => `${row.ref_id}:${row.state}${row.reason ? `:${row.reason}` : ""}`),
  );
const settled = (check: () => unknown) => vi.waitFor(check, { timeout: 5000 });

describe("Inbox requests judged by the real compose table", () => {
  it("held requests are judged by their Inbox items at the window end: waiting and news counted, answered dropped, timed out expired", async () => {
    subs.add(OWNER, device);
    await seed();

    await life(async () => {
      await clock.advance(60_000);
      await settled(() =>
        expect(states()).toEqual(["answered:held", "news:held", "timedOut:held", "waiting:held"]),
      );
    });
    expect(transport.sent).toEqual([]);
    // During the night the owner answers one request, and another one is denied after its 10 minutes (decision 90 a3).
    withDb((db) => {
      const close = "UPDATE inbox_items SET resolved_at = $now, resolution = $resolution WHERE id = $id";
      db.run(close, { now: clock.now(), resolution: "answered", id: "answered" });
      db.run(close, { now: clock.now(), resolution: "timed_out", id: "timedOut" });
    });

    await life(async () => {
      await clock.advance(TO_MORNING_MS);
      await settled(() => expect(transport.sent).toHaveLength(1));
    });
    // Never silently dropped: the answered request is cancelled as gone, the others are counted in the one digest.
    expect(states()).toEqual([
      "answered:cancelled:gone",
      "news:digested:" + digestId(),
      "timedOut:cancelled:expired",
      "waiting:digested:" + digestId(),
    ]);
    const wire = PushWire.parse(JSON.parse(new TextDecoder().decode(transport.sent[0]?.plaintext)));
    expect(wire).toMatchObject({ cls: "digest" });
    expect(wire.body).toBe("2 éléments vous attendent. 1 demande a expiré pendant les heures calmes.");
  });
});

function digestId(): string {
  return withDb((db) => db.get<{ id: string }>("SELECT id FROM push_events WHERE cls = 'digest'")?.id ?? "");
}
