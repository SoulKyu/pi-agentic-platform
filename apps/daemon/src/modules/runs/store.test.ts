import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";
import { createRunsStore, type RunsStore } from "./store.ts";

let bed: RunsBed;
let store: RunsStore;
beforeEach(() => {
  bed = openRunsBed();
  store = createRunsStore(bed.db);
});
afterEach(() => bed.close());

const progress = {
  provider: "anthropic",
  model: "claude",
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 40,
  costUsd: 0.25,
  turns: 2,
  toolCalls: 3,
};
const start = (id: string, extra: Partial<Parameters<RunsStore["insertRunning"]>[0]> = {}) =>
  store.insertRunning({
    id,
    ownerId: "u1",
    sessionId: "s1",
    taskId: null,
    origin: "user",
    startedAt: 1000,
    ...extra,
  });
const finish = (id: string, cost: number, endedAt = 2000) =>
  store.finish(id, {
    ...progress,
    costUsd: cost,
    status: "completed",
    endedAt,
    billing: "api",
    errorClass: null,
    limitResetAt: null,
  });

const insertRaw = (fields: Record<string, string | number | null>) => {
  const row = {
    id: "r",
    owner_id: "u1",
    session_id: "s",
    origin: "user",
    status: "running",
    started_at: 1,
    ended_at: null,
    ...fields,
  };
  bed.db.run(
    "INSERT INTO runs (id, owner_id, session_id, origin, status, started_at, ended_at, limit_reset_at) " +
      "VALUES ($id, $owner_id, $session_id, $origin, $status, $started_at, $ended_at, $limit_reset_at)",
    { limit_reset_at: null, ...row },
  );
};

describe("the runs migration", () => {
  it("accepts a running row without an end and a finished row with one", () => {
    insertRaw({});
    insertRaw({ id: "r2", status: "completed", ended_at: 5 });
    insertRaw({ id: "r3", status: "limited", ended_at: 5, limit_reset_at: 9 });
  });

  it("refuses a running row with an end", () => {
    expect(() => insertRaw({ ended_at: 5 })).toThrow(/CHECK/);
  });

  it("refuses a finished row without an end", () => {
    expect(() => insertRaw({ status: "completed" })).toThrow(/CHECK/);
  });

  it("refuses a reset time on a run that is not limited", () => {
    expect(() => insertRaw({ status: "failed", ended_at: 5, limit_reset_at: 9 })).toThrow(/CHECK/);
  });

  it("refuses an empty origin and one over 32 characters", () => {
    expect(() => insertRaw({ origin: "" })).toThrow(/CHECK/);
    expect(() => insertRaw({ origin: "x".repeat(33) })).toThrow(/CHECK/);
  });

  it("refuses an unknown status and an unknown error class", () => {
    expect(() => insertRaw({ status: "paused", ended_at: 5 })).toThrow(/CHECK/);
    insertRaw({ id: "ok", status: "cancelled", ended_at: 5 });
    expect(() => bed.db.run("UPDATE runs SET error_class = 'nope' WHERE id = 'ok'")).toThrow(/CHECK/);
    for (const errorClass of ["deadline", "run_budget", "budget"])
      bed.db.run("UPDATE runs SET error_class = $errorClass WHERE id = 'ok'", { errorClass });
  });
});

describe("the runs store", () => {
  it("opens a running row, saves progress and finishes it", () => {
    start("r1", { taskId: "t1", origin: "trigger" });
    expect(store.get("r1")).toMatchObject({
      id: "r1",
      status: "running",
      endedAt: null,
      taskId: "t1",
      origin: "trigger",
      costUsd: 0,
      billing: "unknown",
    });
    store.saveProgress("r1", progress);
    expect(store.get("r1")).toMatchObject({ ...progress, status: "running" });
    const done = finish("r1", 0.5);
    expect(done).toMatchObject({
      status: "completed",
      endedAt: 2000,
      billing: "api",
      costUsd: 0.5,
      workspaceId: "default",
    });
    expect(store.running()).toEqual([]);
  });

  it("lists the running rows", () => {
    start("a");
    start("b");
    finish("a", 0);
    expect(store.running().map((row) => row.id)).toEqual(["b"]);
  });

  it("sums the cost a person's automatic runs made since a time, finished ones only", () => {
    start("t", { taskId: "t1", origin: "trigger", startedAt: 5000 });
    finish("t", 1, 6000);
    start("m", { taskId: "t2", origin: "manual", startedAt: 5000 });
    finish("m", 2, 6000);
    start("r", { taskId: "t1", origin: "resume", startedAt: 5000 });
    finish("r", 4, 6000);
    start("u", { startedAt: 5000 });
    finish("u", 8, 6000);
    start("old", { taskId: "t1", origin: "trigger", startedAt: 100 });
    finish("old", 16, 200);
    start("other", { ownerId: "u2", taskId: "t1", origin: "trigger", startedAt: 5000 });
    finish("other", 32, 6000);
    start("open", { taskId: "t1", origin: "trigger", startedAt: 5000 });
    store.saveProgress("open", { ...progress, costUsd: 64 });
    expect(store.spentSince("u1", 1000, null)).toBe(7);
    expect(store.spentSince("u1", 1000, ["t1"])).toBe(5);
    expect(store.spentSince("u1", 1000, [])).toBe(0);
  });

  it("counts a run by the day it ended, within 48 h of its start", () => {
    const DAY = 86_400_000;
    start("crossing", { taskId: "t1", origin: "trigger", startedAt: 10 * DAY - 600_000 });
    finish("crossing", 3, 10 * DAY + 600_000);
    start("ancient", { taskId: "t1", origin: "trigger", startedAt: 5 * DAY });
    finish("ancient", 9, 10 * DAY + 1000);
    expect(store.spentSince("u1", 10 * DAY, null)).toBe(3);
  });

  it("plans the budget sums on an index, never a scan of the table (every assistant message asks)", () => {
    const seen: Array<{ sql: string; params: Record<string, never> }> = [];
    const spy = createRunsStore({
      ...bed.db,
      get: ((sql: string, params: Record<string, never>) => {
        seen.push({ sql, params });
        return bed.db.get(sql, params);
      }) as typeof bed.db.get,
    });
    spy.spentSince("u1", 1_000_000_000, null);
    spy.spentSince("u1", 1_000_000_000, ["t1"]);
    expect(seen).toHaveLength(2);
    for (const { sql, params } of seen) {
      const plan = bed.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
      const details = plan.map((step) => step.detail).join("\n");
      // The index must bound the time range: owner_id alone would read every run the owner ever made.
      expect(details).toMatch(/INDEX runs_owner_started \(owner_id=\? AND started_at>\?\)/);
      expect(details).not.toMatch(/SCAN runs(?! USING)/);
    }
  });

  it("sums a session's finished runs and counts them", () => {
    expect(store.sessionTotals("s1")).toEqual({ runs: 0, costUsd: 0 });
    start("a");
    finish("a", 0.5);
    start("b");
    finish("b", 0.25);
    start("c");
    store.saveProgress("c", { ...progress, costUsd: 9 });
    start("x", { sessionId: "s2" });
    finish("x", 100);
    expect(store.sessionTotals("s1")).toEqual({ runs: 2, costUsd: 0.75 });
  });

  it("groups the runs of a range by origin and by model", () => {
    start("a", { origin: "trigger", taskId: "t", startedAt: 1500 });
    finish("a", 1);
    start("b", { origin: "user", startedAt: 1600 });
    finish("b", 2);
    start("c", { origin: "user", startedAt: 9000 });
    finish("c", 4, 9100);
    expect(store.byOrigin("u1", 1000, 3000)).toEqual([
      { origin: "user", costUsd: 2, tokens: 100, runs: 1 },
      { origin: "trigger", costUsd: 1, tokens: 100, runs: 1 },
    ]);
    expect(store.byModel("u1", 1000, 3000)).toEqual([
      { provider: "anthropic", model: "claude", billing: "api", costUsd: 3, tokens: 200, runs: 2 },
    ]);
    expect(store.totals("u1", 1000, 3000)).toEqual({ costUsd: 3, tokens: 200, runs: 2 });
  });
});
