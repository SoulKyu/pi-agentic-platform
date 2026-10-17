import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationsSettings } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "./kernel/clock.ts";
import { createOutbox, enqueueEffect, type Outbox } from "./kernel/outbox/index.ts";
import { openOutboxBed, type OutboxBed } from "./kernel/testing/outbox-bed.ts";
import { randomToken } from "./kernel/ids.ts";
import { testCaller } from "./testing/caller.ts";
import { composePush } from "./compose-push.ts";
import { PUSH_MIGRATIONS } from "./modules/push/index.ts";
import { subInput } from "./modules/push/testing/transport-bed.ts";
import { pushDepsOf } from "./modules/push/testing/push-deps.ts";

// The production wiring trace (M12 J1): composePush over the daemon's own ports, as `daemon.ts` calls it, with every
// listener counted. A push that is not wired fails silently (M11a I2), so each registration is pinned here.

let bed: OutboxBed;
let home: string;
afterEach(() => {
  bed.close();
  rmSync(home, { recursive: true, force: true });
});

function wire(over: { testPushLoopback?: boolean } = {}) {
  bed = openOutboxBed([PUSH_MIGRATIONS]);
  home = mkdtempSync(join(tmpdir(), "pap-push-wiring-"));
  const clock = createFakeClock();
  const real: Outbox = createOutbox({ db: bed.db, clock, logger: bed.logger, readOnly: false });
  const registered: string[] = [];
  const outbox: Outbox = {
    ...real,
    register: (kind, handler) => {
      registered.push(kind);
      real.register(kind, handler);
    },
  };
  const listening = { inbox: 0, attention: 0, runEnd: 0 };
  const closers: string[] = [];
  const deps = pushDepsOf({
    db: bed.db,
    clock,
    logger: bed.logger,
    readOnly: false,
    closers: { push: (closer: { name: string }) => closers.push(closer.name) },
    config: {
      home,
      publicOrigin: "https://pap.example.net",
      insecureHttp: false,
      pushSubject: null,
      pushExtraHosts: [],
      testPushLoopback: over.testPushLoopback === true,
      tls: null,
    },
    audit: { port: { append: () => {}, reserve: () => true } },
    m10: {
      outbox,
      runs: {
        port: {
          onRunEnd: () => {
            listening.runEnd += 1;
            return () => {};
          },
          spentToday: () => 0,
        },
      },
    },
    auth: { ownerId: () => null, sessionLive: () => true },
    inbox: {
      onItem: () => {
        listening.inbox += 1;
        return () => {};
      },
      get: () => null,
      registeredName: () => null,
    },
    sessions: {
      ownerOf: () => null,
      kindOf: () => null,
      automation: {
        onAttention: () => {
          listening.attention += 1;
          return () => {};
        },
        state: () => null,
      },
    },
    settings: {
      port: {
        automation: () => ({ quietHours: null, timezone: "UTC" }),
        notifications: () => NotificationsSettings.parse({}),
      },
    },
    agents: { port: { get: () => null } },
  });
  const { rpc } = composePush(deps);
  return { rpc, outbox: real, registered, listening, closers, clock, logs: bed.logs };
}

describe("composePush as the daemon calls it", () => {
  it("registers the notifier's sources, the effects and the housekeeping: nothing is left unwired", () => {
    const { registered, listening, closers, rpc } = wire();
    expect(listening).toEqual({ inbox: 1, attention: 1, runEnd: 1 });
    expect(registered.sort()).toEqual(["digest.send", "push.send"]);
    expect(closers.sort()).toEqual([
      "push_budget_source",
      "push_housekeeping",
      "push_inbox_source",
      "push_session_source",
    ]);
    expect(Object.keys(rpc).sort()).toEqual([
      "push.config",
      "push.list",
      "push.open",
      "push.presence",
      "push.revoke",
      "push.subscribe",
      "push.test",
    ]);
  });

  it("without PAP_TEST_PUSH_LOOPBACK a loopback endpoint is refused at subscribe time; with it, accepted (M12R19)", async () => {
    const local = subInput(1, { endpoint: "http://127.0.0.1:4555/push/aaaaaaaaaa" });
    const ctx = {
      caller: testCaller(),
      connectionId: "c1",
      openSubscription: () => "sub",
      closeSubscription: () => {},
    };
    const off = wire();
    await expect(off.rpc["push.subscribe"]({ subscription: local }, ctx)).rejects.toMatchObject({
      code: "bad_request",
    });
    bed.close();
    rmSync(home, { recursive: true, force: true });
    const on = wire({ testPushLoopback: true });
    await expect(on.rpc["push.subscribe"]({ subscription: local }, ctx)).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("push_approval_without_line: an approval no source can vouch for is cancelled gone and logged, never sent", async () => {
    const { outbox, clock, logs } = wire();
    const seed = (cls: "approval" | "failed", refId: string) => {
      const id = randomToken(16);
      bed.db.transaction(() => {
        bed.db.run(
          `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
           VALUES ($id, 'u1', $cls, 'agent', $refId, $key, 'pending', $now)`,
          { id, cls, refId, key: `push:${cls}:agent:${refId}`, now: clock.now() },
        );
        enqueueEffect(
          bed.db,
          { kind: "push.send", ownerId: "u1", payload: { eventId: id }, dedupKey: `push.send:${id}` },
          clock.now(),
        );
      });
      return id;
    };
    const approval = seed("approval", "atlas");
    const failed = seed("failed", "atlas");
    while ((await outbox.drain()) > 0) await clock.advance(0);
    const state = (id: string) =>
      bed.db.get<{ state: string; reason: string | null }>(
        "SELECT state, reason FROM push_events WHERE id = $id",
        { id },
      );
    expect(state(approval)).toEqual({ state: "cancelled", reason: "gone" });
    // news about an unknown kind of ref still goes on to its targets (none here)
    expect(state(failed)?.state).toBe("cancelled");
    expect(state(failed)?.reason).toBe("no_target");
    expect(logs.filter((line) => line.msg === "push_approval_without_line")).toEqual([
      expect.objectContaining({ refKind: "agent" }),
    ]);
  });
});
