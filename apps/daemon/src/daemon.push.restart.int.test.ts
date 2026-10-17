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

// NOTE (final review): in production M11 expires every pending agent request at boot, before push is wired, so an
// `agent_approve` or `secret_request` push pending across a restart is cancelled there (agents/requests.ts). The Inbox row
// seeded below has no request row, a state production cannot reach: this test pins the push module's own rule (W6-R11)
// on a durable row, not the end-to-end outcome of a restart.
// A pending approval push that a restart finds (M12R17, W6-R11): a session's question died with its worker and cancels; an
// Inbox request is a durable row the owner can still answer, so its push is sent once if the row is still open.

const OWNER = "u1";
let home: string;
let clock: FakeClock;
let transport: FakeTransport;
let subs: MemorySubscriptions;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-push-restart-int-"));
  clock = createFakeClock();
  transport = createFakeTransport();
  subs = createMemorySubscriptions();
  subs.add(OWNER, {
    id: "a",
    endpoint: "https://push.example.net/a",
    p256dh: "p",
    auth: "a",
    credentialId: "c-a",
    locale: "en",
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function withDb<T>(work: (db: Db) => T): T {
  const db = openDatabase(join(home, "state.db"));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

async function life<T>(work: () => Promise<T>): Promise<T> {
  const test = await startTestDaemon(
    { steps: [{ text: "unused" }] },
    { config: { home }, deps: { clock, push: { transport, subscriptions: subs, sessionLive: subs } } },
  );
  try {
    return await work();
  } finally {
    await test.stop();
  }
}

function seedPending(
  refKind: "inbox" | "session" | "budget",
  refId: string,
  cls: "approval" | "failed" | "budget" = "approval",
): void {
  const eventId = randomToken(16);
  withDb((db) =>
    db.transaction(() => {
      db.run(
        `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
         VALUES ($eventId, $owner, $cls, $kind, $ref, $key, 'pending', $now)`,
        {
          eventId,
          owner: OWNER,
          cls,
          kind: refKind,
          ref: refId,
          key: `push:${cls}:${refKind}:${refId}`,
          now: clock.now(),
        },
      );
      enqueueEffect(
        db,
        { kind: "push.send", ownerId: OWNER, payload: { eventId }, dedupKey: `push.send:${eventId}` },
        clock.now(),
      );
    }),
  );
}

const states = () =>
  withDb((db) =>
    db
      .all<{ ref_id: string; state: string; reason: string | null }>(
        "SELECT ref_id, state, reason FROM push_events ORDER BY ref_id",
      )
      .map((row) => `${row.ref_id}:${row.state}${row.reason ? `:${row.reason}` : ""}`),
  );

describe("approval pushes pending at a restart", () => {
  it("a session's question is cancelled gone, an open Inbox request is sent once, an answered one is cancelled", async () => {
    await life(async () => undefined);
    withDb((db) => {
      for (const [id, resolved] of [
        ["open", null],
        ["done", 1],
      ] as const)
        db.run(
          `INSERT INTO inbox_items (id, owner_id, kind, to_handle, title, created_at, agent_id, ref_id, resolved_at, resolution)
           VALUES ($id, $owner, 'agent_approve', 1, 'agent', $now, 'atlas-1a2b', $id, $resolved, $resolution)`,
          { id, owner: OWNER, now: clock.now(), resolved, resolution: resolved === null ? null : "answered" },
        );
    });
    seedPending("session", "dead-session");
    seedPending("inbox", "open");
    seedPending("inbox", "done");

    await life(async () => {
      await clock.advance(0);
      await vi.waitFor(() => expect(states().every((s) => !s.endsWith(":pending"))).toBe(true), {
        timeout: 5000,
      });
    });
    expect(states()).toEqual(["dead-session:cancelled:gone", "done:cancelled:gone", "open:sent"]);
    expect(transport.sent).toHaveLength(1);
  });

  it("restart-recovery (M12R17): the approval cancels, failed and budget are sent once, a sent event is not sent again", async () => {
    await life(async () => undefined);
    seedPending("session", "dead-session");
    seedPending("session", "broken-task", "failed");
    seedPending("budget", "owner:2026-10-17", "budget");

    await life(async () => {
      await clock.advance(0);
      await vi.waitFor(() => expect(states().every((s) => !s.endsWith(":pending"))).toBe(true), {
        timeout: 5000,
      });
    });
    expect(states()).toEqual(["broken-task:sent", "dead-session:cancelled:gone", "owner:2026-10-17:sent"]);
    expect(transport.sent).toHaveLength(2);

    // A third life: the outbox rows are done and the events are settled, so nothing is sent a second time.
    withDb((db) => db.run("UPDATE outbox SET status = 'pending', settled_at = NULL"));
    await life(async () => {
      await clock.advance(0);
      await vi.waitFor(
        () => expect(withDb((db) => db.all("SELECT 1 FROM outbox WHERE status = 'pending'"))).toEqual([]),
        { timeout: 5000 },
      );
    });
    expect(transport.sent).toHaveLength(2);
  });
});
