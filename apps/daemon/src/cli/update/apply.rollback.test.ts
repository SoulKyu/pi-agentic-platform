import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyRelease, rollback } from "./apply.ts";
import { harness, URL_READY, type Harness } from "../testing/apply-harness.ts";
import type { Pending } from "./pending.ts";
import { readPending } from "./pending.ts";
import { readCurrent, switchCurrent } from "./releases.ts";
import { snapshotDatabase } from "../ops/snapshot.ts";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

const NEVER = { kind: "never" } as const;
const pairs = (calls: string[]): boolean =>
  calls.every((call, i) => call !== "restart" || calls[i - 1] === "reset-failed");

describe("applyRelease, failure and rollback", () => {
  it("2: the new release never listens after a migration ran: snapshot restored, old rows back", async () => {
    h = harness({ ctl: { migrate: true, listening: [NEVER, URL_READY] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rolled_back",
      reason: "the new release did not start listening",
      restoredDatabase: true,
      keptDatabase: expect.stringMatching(/\/backups\/pre-rollback-.+\.db$/),
    });
    expect(h.rows()).toEqual(["a"]);
    expect(h.ids()).toEqual(["001"]);
    expect(readCurrent(h.app)).toBe("old");
    expect(readPending(h.home)).toBeNull();
    expect(h.calls).toEqual(["stop", "reset-failed", "restart", "stop", "reset-failed", "restart"]);
    expect(pairs(h.calls)).toBe(true);
    expect(h.steps.includes("rolling_back")).toBe(true);
  });

  it("3: the daemon dies in the settle window without a migration: rolled back, database NOT restored", async () => {
    h = harness({ ctl: { writeRow: true, states: ["failed"], listening: [URL_READY] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rolled_back",
      reason: "the new release stopped or restarted during the settle window",
      restoredDatabase: false,
    });
    expect(h.rows()).toEqual(["a", "w"]); // what the new release wrote stays
    expect(readCurrent(h.app)).toBe("old");
    expect(pairs(h.calls)).toBe(true);
  });

  it("4: the restart counter moved: rolled back", async () => {
    h = harness({ ctl: { restarts: [0, 1] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rolled_back",
      reason: "the new release stopped or restarted during the settle window",
      restoredDatabase: false,
    });
    expect(readCurrent(h.app)).toBe("old");
    expect(pairs(h.calls)).toBe(true);
  });

  it("a restart counter that cannot be read is a failure, not a pass (M2)", async () => {
    h = harness({ ctl: { restarts: [null] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rolled_back",
      reason: "the restart counter of the unit cannot be read",
      restoredDatabase: false,
    });
    expect(readCurrent(h.app)).toBe("old");
  });

  it("a health probe that fails after the settle window rolls back", async () => {
    h = harness({ ctl: { healthz: [true, false, true] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rolled_back",
      reason: "the new release stopped or restarted during the settle window",
      restoredDatabase: false,
    });
    expect(pairs(h.calls)).toBe(true);
  });

  it("a health probe that fails right after listening rolls back with its own reason", async () => {
    h = harness({ ctl: { healthz: [false] } });
    expect(await applyRelease(h.deps, "new")).toMatchObject({
      kind: "rolled_back",
      reason: "the health probe failed",
    });
  });

  it("5: the old release does not listen after the rollback: rollback_failed, pending kept at rolling_back", async () => {
    h = harness({ ctl: { listening: [NEVER] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rollback_failed",
      reason: "the new release did not start listening",
      step: "old_release_not_listening",
    });
    expect(readPending(h.home)).toMatchObject({ step: "rolling_back", from: "old", to: "new" });
    expect(readCurrent(h.app)).toBe("old");
    expect(pairs(h.calls)).toBe(true);
  });

  it("5b (I2): the old release has an unreadable journal and is unhealthy: rollback_failed / old_release_unverified, journal kept", async () => {
    h = harness({ ctl: { listening: [NEVER, { kind: "unreadable" }], healthz: [false] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rollback_failed",
      reason: "the new release did not start listening",
      step: "old_release_unverified",
    });
    expect(readPending(h.home)).toMatchObject({ step: "rolling_back" });
    expect(pairs(h.calls)).toBe(true);
  });

  it("5c (I2): unreadable journal, healthy but the unit is not active: rollback_failed / old_release_unverified", async () => {
    h = harness({ ctl: { listening: [NEVER, { kind: "unreadable" }], states: ["failed"] } });
    expect(await applyRelease(h.deps, "new")).toMatchObject({
      kind: "rollback_failed",
      step: "old_release_unverified",
    });
    expect(readPending(h.home)).not.toBeNull();
    expect(pairs(h.calls)).toBe(true);
  });

  it("5d (I2): unreadable journal, healthy and active: rolled back, journal cleared", async () => {
    h = harness({ ctl: { listening: [NEVER, { kind: "unreadable" }] } });
    expect(await applyRelease(h.deps, "new")).toMatchObject({ kind: "rolled_back", restoredDatabase: false });
    expect(readPending(h.home)).toBeNull();
    expect(pairs(h.calls)).toBe(true);
  });

  it("8: the first stop throws: rolled back with the generic reason, current unchanged", async () => {
    h = harness({
      ctl: {
        stopHook: (n) => {
          if (n === 0) throw new Error("systemctl exploded");
        },
      },
    });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rolled_back",
      reason: "the unit could not be stopped",
      restoredDatabase: false,
    });
    expect(readCurrent(h.app)).toBe("old");
    expect(readPending(h.home)).toBeNull();
    expect(h.calls).toEqual(["stop", "stop", "reset-failed", "restart"]);
    expect(pairs(h.calls)).toBe(true);
  });

  it("9: unreadable journal, unhealthy daemon, a migration ran: rolled back and restored (M6b-RT-05)", async () => {
    h = harness({ ctl: { migrate: true, listening: [{ kind: "unreadable" }, URL_READY], healthz: [false] } });
    expect(await applyRelease(h.deps, "new")).toMatchObject({ kind: "rolled_back", restoredDatabase: true });
    expect(h.rows()).toEqual(["a"]);
    expect(readCurrent(h.app)).toBe("old");
    expect(pairs(h.calls)).toBe(true);
  });

  it("9b: unreadable journal, healthz ok, ActiveState failed in the settle window: rolled back", async () => {
    h = harness({ ctl: { listening: [{ kind: "unreadable" }, URL_READY], states: ["failed"] } });
    expect(await applyRelease(h.deps, "new")).toMatchObject({ kind: "rolled_back", restoredDatabase: false });
    expect(readCurrent(h.app)).toBe("old");
    expect(pairs(h.calls)).toBe(true);
  });

  it("10: holdHome throws after the stop: rollback_failed / lock, pending kept, current unchanged, no snapshot", async () => {
    h = harness({ ctl: { holdFails: true } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rollback_failed",
      reason: "the home is locked by another pap process",
      step: "lock",
    });
    expect(readPending(h.home)).toMatchObject({ step: "rolling_back", snapshot: null });
    expect(readCurrent(h.app)).toBe("old");
    expect(existsSync(join(h.home, "backups"))).toBe(false);
    expect(h.calls).toEqual(["stop", "stop"]);
  });

  it("10b: a switch failure releases the lock once per hold, before the next reset-failed", async () => {
    h = harness({
      ctl: {
        stopHook: (n) => {
          if (n === 0) rmSync(join(h?.app ?? "", "releases", "new", "node", "bin", "node")); // vanishes after preflight
        },
      },
    });
    const outcome = await applyRelease(h.deps, "new");
    expect(outcome).toMatchObject({
      kind: "rolled_back",
      reason: "switching to the new release failed",
      restoredDatabase: false,
    });
    expect(readCurrent(h.app)).toBe("old");
    expect(h.events).toEqual([
      "stop",
      "hold",
      "release",
      "stop",
      "hold",
      "release",
      "reset-failed",
      "restart",
    ]);
    expect(readdirSync(join(h.home, "backups"))).toHaveLength(1);
  });

  it("11: writePending throws inside the rollback: rollback_failed / error, no stop, no re-entry", async () => {
    h = harness({ ctl: { listening: [NEVER] } });
    const pending = pendingWithJournalFolder(h);
    chmodSync(join(h.home, "update"), 0o500);
    try {
      expect(await rollback(h.deps, pending, "boom")).toEqual({
        kind: "rollback_failed",
        reason: "boom",
        step: "error",
      });
    } finally {
      chmodSync(join(h.home, "update"), 0o700);
    }
    expect(h.calls).toEqual([]);
  });

  it("11b: listening throws on both starts: the rollback ran once (stop twice, not three times)", async () => {
    h = harness({ ctl: { listening: ["throw"] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "rollback_failed",
      reason: "the new release could not be verified",
      step: "error",
    });
    expect(h.calls.filter((c) => c === "stop")).toHaveLength(2);
    expect(readPending(h.home)).toMatchObject({ step: "rolling_back" });
    expect(pairs(h.calls)).toBe(true);
  });
});

function pendingWithJournalFolder(env: Harness): Pending {
  mkdirSync(join(env.home, "update"), { recursive: true, mode: 0o700 }); // so the later chmod can make it read-only
  return { ...basePending };
}

const basePending: Pending = {
  format: 1,
  from: "old",
  to: "new",
  step: "started",
  snapshot: null,
  schemaBefore: ["001"],
  startedAt: "2026-10-17T10:00:00.000Z",
};

/** What a killed `pap update apply` leaves: current on `new`, the new release's migration in the database. */
async function killedAfterRestart(env: Harness, snapshot: string | null): Promise<void> {
  if (snapshot !== null) snapshotDatabase(join(env.home, "state.db"), join(env.home, "backups", snapshot));
  switchCurrent(env.app, "new");
  await env.deps.systemd.restart("pap.service"); // the harness's new release migrates here
  env.calls.length = 0;
}

describe("rollback() directly (what `pap update recover` runs)", () => {
  it("I1: snapshot null with a migrated database is rollback_failed / database, journal kept, database untouched", async () => {
    h = harness({ ctl: { migrate: true } });
    await killedAfterRestart(h, null);
    expect(await rollback(h.deps, basePending, "crash")).toEqual({
      kind: "rollback_failed",
      reason: "crash",
      step: "database",
      code: "the journal names no snapshot: the database cannot be restored automatically",
    });
    expect(h.ids()).toEqual(["001", "002"]);
    expect(readCurrent(h.app)).toBe("new");
    expect(readPending(h.home)).toMatchObject({ step: "rolling_back" });
    expect(h.calls).toEqual(["stop"]);
  });

  it("snapshot null and an unmigrated database: rolled back without touching the database", async () => {
    h = harness();
    switchCurrent(h.app, "new");
    expect(await rollback(h.deps, basePending, "crash")).toEqual({
      kind: "rolled_back",
      reason: "crash",
      restoredDatabase: false,
    });
    expect(h.rows()).toEqual(["a"]);
    expect(readCurrent(h.app)).toBe("old");
    expect(h.calls).toEqual(["stop", "reset-failed", "restart"]);
  });

  it("M11: the rollback asks for `listening` since a time taken before its restart (the restart moves the clock)", async () => {
    h = harness();
    let clock = Date.parse("2026-10-17T10:00:00.000Z");
    const seen: Date[] = [];
    await rollback(
      {
        ...h.deps,
        now: () => new Date(clock),
        systemd: {
          ...h.deps.systemd,
          restart: async () => {
            clock += 5000; // the restart takes time: a `since` read after it would be 10:00:05
          },
        },
        listening: async (since) => {
          seen.push(since);
          return URL_READY;
        },
      },
      basePending,
      "x",
    );
    expect(seen.map((at) => at.toISOString())).toEqual(["2026-10-17T10:00:00.000Z"]);
  });

  it("restores the named snapshot from the journal alone when a migration ran", async () => {
    h = harness({ ctl: { migrate: true } });
    const snapshot = "pre-update-new-2026-10-17T10-00-00-000Z.db";
    await killedAfterRestart(h, snapshot);
    expect(await rollback(h.deps, { ...basePending, snapshot }, "recover")).toEqual({
      kind: "rolled_back",
      reason: "recover",
      restoredDatabase: true,
      keptDatabase: expect.stringMatching(/\/backups\/pre-rollback-.+\.db$/),
    });
    expect(h.rows()).toEqual(["a"]);
    expect(readCurrent(h.app)).toBe("old");
    expect(readPending(h.home)).toBeNull();
    expect(pairs(h.calls)).toBe(true);
  });

  it("a missing snapshot file after a migration is rollback_failed / database, not a silent pass", async () => {
    h = harness({ ctl: { migrate: true } });
    await killedAfterRestart(h, null);
    const outcome = await rollback(h.deps, { ...basePending, snapshot: "pre-update-gone.db" }, "recover");
    expect(outcome).toEqual({
      kind: "rollback_failed",
      reason: "recover",
      step: "database",
      code: "the snapshot is damaged: nothing was restored",
    });
    expect(readCurrent(h.app)).toBe("new");
  });

  it("a stop that throws is rollback_failed / stop", async () => {
    h = harness({
      ctl: {
        stopHook: () => {
          throw new Error("no");
        },
      },
    });
    expect(await rollback(h.deps, basePending, "x")).toEqual({
      kind: "rollback_failed",
      reason: "x",
      step: "stop",
    });
  });
});
