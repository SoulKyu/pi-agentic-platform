import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplyRefused, applyRelease, preflight } from "./apply.ts";
import { harness, type Harness } from "../testing/apply-harness.ts";
import { readPending } from "./pending.ts";
import { readCurrent } from "./releases.ts";

let h: Harness | undefined;
afterEach(() => h?.cleanup());
const env = (): Harness => {
  if (h === undefined) throw new Error("no harness");
  return h;
};

const snapshots = (home: string): string[] =>
  existsSync(join(home, "backups"))
    ? readdirSync(join(home, "backups")).filter((n) => n.startsWith("pre-update-"))
    : [];

describe("applyRelease, success", () => {
  it("1: with a migration: updated, new rows kept, pending gone, calls stop, reset-failed, restart", async () => {
    h = harness({ ctl: { migrate: true } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "updated",
      snapshot: "pre-update-new-2026-10-17T10-00-00-000Z.db",
    });
    expect(readCurrent(h.app)).toBe("new");
    expect(h.ids()).toEqual(["001", "002"]);
    expect(h.rows()).toEqual(["a", "m"]);
    expect(readPending(h.home)).toBeNull();
    expect(h.calls).toEqual(["stop", "reset-failed", "restart"]);
    expect(h.events).toEqual(["stop", "hold", "release", "reset-failed", "restart"]);
    expect(snapshots(h.home)).toEqual(["pre-update-new-2026-10-17T10-00-00-000Z.db"]);
    expect(statSync(join(h.home, "backups", snapshots(h.home)[0] as string)).mode & 0o777).toBe(0o600);
  });

  it("an install with no database yet: no snapshot, still updated", async () => {
    h = harness({ withDb: false });
    expect(await applyRelease(h.deps, "new")).toEqual({ kind: "updated", snapshot: null });
    expect(readCurrent(h.app)).toBe("new");
    expect(existsSync(join(h.home, "backups"))).toBe(false);
  });

  it("6: an unreadable journal with a healthy daemon is unverified, current stays new, pending cleared", async () => {
    h = harness({ ctl: { listening: [{ kind: "unreadable" }] } });
    expect(await applyRelease(h.deps, "new")).toEqual({
      kind: "unverified",
      snapshot: "pre-update-new-2026-10-17T10-00-00-000Z.db",
    });
    expect(readCurrent(h.app)).toBe("new");
    expect(readPending(h.home)).toBeNull();
    expect(h.calls).toEqual(["stop", "reset-failed", "restart"]);
  });

  it("writes pending.step stopping, switched, started in that order", async () => {
    h = harness();
    await applyRelease(h.deps, "new");
    // stop, reset-failed, restart, then the listening call
    expect(h.steps).toEqual(["stopping", "switched", "switched", "started"]);
  });

  it("takes the snapshot after the stop, never before", async () => {
    h = harness({
      ctl: {
        stopHook: () => {
          expect(snapshots(h?.home ?? "")).toEqual([]);
        },
      },
    });
    const outcome = await applyRelease(h.deps, "new");
    expect(outcome).toEqual({ kind: "updated", snapshot: "pre-update-new-2026-10-17T10-00-00-000Z.db" });
    expect(h.events.indexOf("stop")).toBeLessThan(h.events.indexOf("hold"));
    expect(snapshots(h.home)).toHaveLength(1);
  });

  it("holds the instance lock exactly once and releases it before reset-failed", async () => {
    h = harness();
    await applyRelease(h.deps, "new");
    expect(h.events.filter((e) => e === "hold")).toHaveLength(1);
    expect(h.events.filter((e) => e === "release")).toHaveLength(1);
    expect(h.events.indexOf("release")).toBeLessThan(h.events.indexOf("reset-failed"));
  });
});

describe("preflight", () => {
  it("7: a database with an id the new release does not know is refused and nothing is touched", async () => {
    h = harness();
    await expect(applyRelease({ ...h.deps, knownIds: new Set(["000"]) }, "new")).rejects.toThrow(
      /written by a newer pap.*pap restore.*pap update rollback/,
    );
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([]);
    expect(readPending(h.home)).toBeNull();
    expect(readCurrent(h.app)).toBe("old");
    expect(snapshots(h.home)).toEqual([]);
  });

  it("refuses with ApplyRefused: no current, from === to, an incomplete target", () => {
    h = harness();
    expect(() => preflight(env().deps, "old")).toThrow(ApplyRefused);
    expect(() => preflight(env().deps, "old")).toThrow("release old is already the current one");
    expect(() => preflight(env().deps, "ghost")).toThrow("release ghost is incomplete: nothing was changed");
    expect(() => preflight(env().deps, "..")).toThrow("invalid release id");
    expect(() => preflight({ ...env().deps, app: join(env().root, "empty") }, "new")).toThrow(
      /no installed release/,
    );
  });

  it("refuses when the disk is below 2 x size + 64 MB, with the numbers", () => {
    h = harness();
    const size = statSync(join(h.home, "state.db")).size;
    const needed = Math.ceil((size * 2) / 1_048_576) + 64;
    expect(needed).toBe(65);
    expect(() => preflight({ ...env().deps, freeMb: () => 10 }, "new")).toThrow(
      `not enough disk space for the snapshot (${needed} MB needed, 10 MB free)`,
    );
    expect(() => preflight({ ...env().deps, freeMb: () => needed }, "new")).not.toThrow();
    expect(() => preflight({ ...env().deps, freeMb: () => null }, "new")).not.toThrow();
  });

  it("M3: an invalid id and a journal that cannot be written are ApplyRefused with fixed sentences, nothing touched", async () => {
    h = harness();
    await expect(applyRelease(env().deps, "a/b")).rejects.toThrow("invalid release id: nothing was changed");
    await expect(applyRelease(env().deps, "x".repeat(65))).rejects.toBeInstanceOf(ApplyRefused);
    mkdirSync(join(env().home, "update"), { recursive: true });
    chmodSync(join(env().home, "update"), 0o500);
    try {
      await expect(applyRelease(env().deps, "new")).rejects.toThrow(
        /journal cannot be written.*nothing was changed/,
      );
    } finally {
      chmodSync(join(env().home, "update"), 0o700);
    }
    expect(env().calls).toEqual([]);
    expect(readCurrent(env().app)).toBe("old");
    expect(readdirSync(join(env().home, "update"))).toEqual([]);
  });

  it("refuses an unreadable database", () => {
    h = harness();
    // not a database
    writeFileSync(join(h.home, "state.db"), "not sqlite at all, padded".repeat(50));
    expect(() => preflight(env().deps, "new")).toThrow(/cannot be read or is damaged.*pap restore/);
  });

  it("with no database returns ids null", () => {
    h = harness({ withDb: false });
    expect(preflight(h.deps, "new")).toMatchObject({ from: "old", ids: null });
  });
});
