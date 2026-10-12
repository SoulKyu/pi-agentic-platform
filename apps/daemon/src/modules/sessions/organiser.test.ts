import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Marks, NO_MARKS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { SESSIONS_MIGRATIONS } from "./index.ts";
import { createMarksStore, type MarksStore } from "./marks-store.ts";
import { createOrganiser, SWEEP_EVERY_MS } from "./organiser.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";

const T = 1_800_000_000_000;
const DAY = 86_400_000;
let dir: string;
let db: Db;
let marks: MarksStore;
let clock: FakeClock;
let changed: string[];
let live: Set<string>;
let lines: Array<Record<string, unknown>>;
let deps: Parameters<typeof createOrganiser>[0];
let organiser: ReturnType<typeof createOrganiser>;

const addIdle = (id: string, updatedAt: number) =>
  createSessionsStore(db).insert(
    {
      id,
      piPath: null,
      piSessionId: null,
      cwd: `/w/${id}`,
      ownerId: "u1",
      name: null,
      createdAt: 1,
      updatedAt,
    },
    null,
  );
const write = (id: string, change: Partial<Marks>, updatedAt = T - DAY) => {
  if (!marks.row(id)) addIdle(id, updatedAt);
  marks.write(id, { ...NO_MARKS, ...change }, null);
};
const settled = () =>
  db
    .all<{ id: string }>("SELECT id FROM sessions WHERE settled_at IS NOT NULL ORDER BY id")
    .map((row) => row.id);
const failures = (msg: string) => lines.filter((line) => line["msg"] === msg);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-organiser-"));
  clock = createFakeClock(T);
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock,
    logger: captureLogger().logger,
  }).db;
  marks = createMarksStore(db);
  changed = [];
  live = new Set();
  const captured = captureLogger();
  lines = captured.lines;
  deps = {
    store: marks,
    clock,
    logger: captured.logger,
    publisher: {
      changed: (id) => void changed.push(id),
      projectChanged: () => {},
      countsChanged: () => {},
    },
    isLive: (id) => live.has(id),
    readOnly: false,
  };
  organiser = createOrganiser(deps);
});
afterEach(() => {
  organiser.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("organiser", () => {
  it("settles sessions idle for 3 days, and none that is pinned, snoozed, archived, live or freshly unsettled", async () => {
    const old = T - 4 * DAY;
    addIdle("idle", old);
    write("pinned", { pinRank: 1 }, old);
    write("snoozed", { snoozedUntil: T + DAY }, old);
    write("archived", { archivedAt: T - DAY }, old);
    addIdle("live", old);
    live.add("live");
    write("unsettled", { unsettledAt: T - DAY }, old);
    addIdle("fresh", T - DAY);
    organiser.start();
    await clock.advance(0);
    expect(settled()).toEqual(["idle"]);
    expect(marks.row("idle")?.marks).toMatchObject({ settledAt: T, settledAuto: true });
    expect(changed).toEqual(["idle"]);
  });

  it("works through more than one batch, a batch per turn", async () => {
    db.transaction(() => {
      for (let i = 0; i < 501; i++) addIdle(`s${String(i).padStart(3, "0")}`, T - 4 * DAY + i);
    });
    organiser.start();
    expect(settled()).toHaveLength(500);
    await clock.advance(0);
    expect(settled()).toHaveLength(501);
  });

  it("sweeps again every hour", async () => {
    organiser.start();
    await clock.advance(0);
    addIdle("late", T - 3 * DAY + 10 * 60_000);
    await clock.advance(SWEEP_EVERY_MS);
    expect(settled()).toContain("late");
  });

  it("wakes a snooze at its time, the earliest first, and re-arms", async () => {
    write("a", { snoozedUntil: T + 60_000 });
    write("b", { snoozedUntil: T + 120_000 });
    organiser.start();
    await clock.advance(60_000);
    expect(marks.row("a")?.marks.snoozedUntil).toBeNull();
    expect(marks.row("b")?.marks.snoozedUntil).toBe(T + 120_000);
    await clock.advance(60_000);
    expect(marks.row("b")?.marks.snoozedUntil).toBeNull();
    expect(changed).toEqual(["a", "b"]);
  });

  it("re-arms when a snooze changes", async () => {
    organiser.start();
    write("a", { snoozedUntil: T + 30_000 });
    organiser.rearm();
    await clock.advance(30_000);
    expect(marks.row("a")?.marks.snoozedUntil).toBeNull();
  });

  it("activity un-settles and wakes, and writes nothing for an active session", () => {
    write("s", { settledAt: T - 5, settledAuto: true, snoozedUntil: null });
    write("z", { snoozedUntil: T + 999_999 });
    addIdle("plain", T);
    organiser.activity("s");
    organiser.activity("z");
    organiser.activity("plain");
    expect(marks.row("s")?.marks).toMatchObject({ settledAt: null, settledAuto: false });
    expect(marks.row("z")?.marks.snoozedUntil).toBeNull();
    expect(changed).toEqual(["s", "z"]);
  });

  it("a store that throws inside the sweep is said once and the sweep stays armed (RT-04)", async () => {
    addIdle("idle", T - 4 * DAY);
    const broken = createOrganiser({
      ...deps,
      store: {
        ...marks,
        write: () => {
          throw new Error("SQLITE_FULL");
        },
      },
    });
    broken.start();
    await clock.advance(0);
    expect(failures("sessions_sweep_failed")).toHaveLength(1);
    expect(clock.pending()).toBe(1);
    await clock.advance(SWEEP_EVERY_MS);
    expect(failures("sessions_sweep_failed")).toHaveLength(2);
    broken.stop();
  });

  it("a store that cannot say the next snooze arms a retry instead of throwing (RT-04)", () => {
    const broken = createOrganiser({
      ...deps,
      store: {
        ...marks,
        nextSnooze: () => {
          throw new Error("SQLITE_IOERR");
        },
      },
    });
    expect(() => broken.start()).not.toThrow();
    expect(failures("sessions_wake_failed")).toHaveLength(1);
    expect(clock.pending()).toBe(2);
    broken.stop();
  });

  it("a live session in a full batch does not make the sweep spin", async () => {
    addIdle("live", T - 4 * DAY);
    live.add("live");
    const thin = createOrganiser({
      ...deps,
      store: { ...marks, settleCandidates: () => Array.from({ length: 500 }, () => "live") },
    });
    thin.start();
    await clock.advance(0);
    expect(clock.pending()).toBe(1);
    thin.stop();
  });

  it("in read-only mode it arms nothing and writes nothing (M4R43)", async () => {
    write("s", { settledAt: T - 5, settledAuto: true });
    addIdle("idle", T - 4 * DAY);
    const readOnly = createOrganiser({ ...deps, readOnly: true });
    readOnly.start();
    readOnly.activity("s");
    await clock.advance(0);
    expect(clock.pending()).toBe(0);
    expect(marks.row("idle")?.marks.settledAt).toBeNull();
    expect(marks.row("s")?.marks.settledAt).toBe(T - 5);
  });

  it("stop leaves no timer", async () => {
    write("a", { snoozedUntil: T + 60_000 });
    organiser.start();
    await clock.advance(0);
    organiser.stop();
    expect(clock.pending()).toBe(0);
  });
});
