import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { type Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { SUBAGENTS_MIGRATIONS } from "./index.ts";
import { createSubagentStore } from "./store.ts";

const dirs: string[] = [];
const open = (): Db => {
  const dir = mkdtempSync(join(tmpdir(), "pap-subagents-store-"));
  dirs.push(dir);
  return migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, SUBAGENTS_MIGRATIONS],
    clock: createFakeClock(1),
    logger: silentLogger,
  }).db;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const start = (store: ReturnType<typeof createSubagentStore>, id: string, parent = "p1", at = 1_000) =>
  store.start({ id, ownerId: "u1", parentSessionId: parent, profile: null, title: "Look", startedAt: at });

describe("the subagent_runs table (M11R134)", () => {
  it("refuses an ended state without ended_at, and ended_at on a live state", () => {
    const db = open();
    const insert = (state: string, endedAt: number | null) =>
      db.run(
        `INSERT INTO subagent_runs (id, owner_id, parent_session_id, title, state, started_at, ended_at)
         VALUES ($id, 'u1', 'p1', 'T', $state, 1, $endedAt)`,
        { id: `${state}-${endedAt}`, state, endedAt },
      );
    expect(() => insert("done", null)).toThrow();
    expect(() => insert("failed", null)).toThrow();
    expect(() => insert("running", 5)).toThrow();
    expect(() => insert("starting", 5)).toThrow();
    expect(() => insert("done", 5)).not.toThrow();
    expect(() => insert("running", null)).not.toThrow();
  });

  it("refuses an unknown state, an empty title and a title over 120 characters", () => {
    const db = open();
    const insert = (title: string, state = "starting") =>
      db.run(
        `INSERT INTO subagent_runs (id, owner_id, parent_session_id, title, state, started_at)
         VALUES ($id, 'u1', 'p1', $title, $state, 1)`,
        { id: `${title.length}${state}`, title, state },
      );
    expect(() => insert("T", "paused")).toThrow();
    expect(() => insert("")).toThrow();
    expect(() => insert("x".repeat(121))).toThrow();
    expect(() => insert("x".repeat(120))).not.toThrow();
  });
});

describe("the subagent store", () => {
  it("starts a row, binds the child, and ends it with a reason", () => {
    const store = createSubagentStore(open());
    start(store, "r1");
    expect(store.get("r1")).toMatchObject({ state: "starting", childSessionId: null, endedAt: null });
    store.running("r1", "child-1");
    expect(store.get("r1")).toMatchObject({ state: "running", childSessionId: "child-1" });
    store.finish("r1", "failed", "child_failed", 2_000);
    expect(store.get("r1")).toMatchObject({ state: "failed", reason: "child_failed", endedAt: 2_000 });
  });

  it("finishes a row once: a second end does not rewrite how it ended", () => {
    const store = createSubagentStore(open());
    start(store, "r1");
    expect(store.finish("r1", "cancelled", "stopped", 2_000)).toBe(true);
    expect(store.finish("r1", "done", null, 3_000)).toBe(false);
    expect(store.get("r1")).toMatchObject({ state: "cancelled", reason: "stopped", endedAt: 2_000 });
  });

  it("counts the live children of one parent and the starts of one owner since a time", () => {
    const store = createSubagentStore(open());
    start(store, "r1", "p1", 1_000);
    start(store, "r2", "p1", 2_000);
    start(store, "r3", "p2", 3_000);
    store.finish("r2", "done", null, 4_000);
    expect(store.liveOf("p1")).toBe(1);
    expect(store.liveOf("p2")).toBe(1);
    expect(store.startedSince("u1", 1_500)).toBe(2);
    expect(store.startedSince("u1", 0)).toBe(3);
    expect(store.startedSince("u2", 0)).toBe(0);
  });

  it("marks every live row interrupted at boot, and says how many", () => {
    const store = createSubagentStore(open());
    start(store, "r1");
    start(store, "r2");
    store.running("r2", "c2");
    start(store, "r3");
    store.finish("r3", "done", null, 1_500);
    expect(store.interruptLive(9_000)).toBe(2);
    expect(store.get("r1")).toMatchObject({ state: "interrupted", reason: "restart", endedAt: 9_000 });
    expect(store.get("r2")).toMatchObject({ state: "interrupted" });
    expect(store.get("r3")).toMatchObject({ state: "done" });
    expect(store.liveOf("p1")).toBe(0);
  });
});

describe("childrenOf (M11R140: the parent's screen)", () => {
  it("lists the newest children that have a session, with their profile and state, at most `limit`", () => {
    const store = createSubagentStore(open());
    start(store, "r1", "p1", 1_000);
    start(store, "r2", "p1", 2_000);
    start(store, "r3", "p1", 3_000);
    start(store, "r4", "p1", 4_000);
    start(store, "other", "p2", 5_000);
    store.running("r1", "c1");
    store.running("r2", "c2");
    store.running("r3", "c3");
    store.finish("r2", "done", null, 6_000);
    // r4 has no child session yet (starting): nothing to open, nothing to answer.
    expect(store.childrenOf("p1", 2).map((row) => [row.childSessionId, row.state])).toEqual([
      ["c3", "running"],
      ["c2", "done"],
    ]);
    expect(store.childrenOf("p1", 8).map((row) => row.childSessionId)).toEqual(["c3", "c2", "c1"]);
    expect(store.childrenOf("p9", 8)).toEqual([]);
  });
});
