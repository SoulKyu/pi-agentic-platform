import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { RunEndEvent } from "../runs/index.ts";
import { SUBAGENTS_MIGRATIONS } from "./index.ts";
import { createSubagentStop } from "./stop.ts";
import { createSubagentStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bed(agents: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pap-subagents-stop-"));
  dirs.push(dir);
  const clock = createFakeClock(7_000);
  const db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, SUBAGENTS_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  const store = createSubagentStore(db);
  const aborted: string[] = [];
  const cleared: string[] = [];
  const sessions = {
    abort: vi.fn(async (_ownerId: string, sessionId: string) => void aborted.push(sessionId)),
    agentOf: (parentId: string): string | null => agents[parentId] ?? null,
  };
  const runs = { clearExpected: (sessionId: string) => void cleared.push(sessionId) };
  const stop = createSubagentStop({ clock, logger: silentLogger, store, sessions, runs });
  let rows = 0;
  /** A running child of `parentId`, held by a guard the way the service holds it. */
  const child = (parentId: string, ownerId = "u1", signal = new AbortController().signal) => {
    rows += 1;
    const rowId = `row-${rows}`;
    const childId = `child-${rows}`;
    store.start({ id: rowId, ownerId, parentSessionId: parentId, profile: null, title: "T", startedAt: 1 });
    store.running(rowId, childId);
    return { rowId, childId, guard: stop.guard({ rowId, ownerId, parentId, childId, signal }) };
  };
  return { stop, store, sessions, aborted, cleared, child, clock, db };
}

const runEnd = (sessionId: string): RunEndEvent => ({
  runId: "r",
  sessionId,
  ownerId: "u1",
  taskId: null,
  origin: "user",
  status: "completed",
  costUsd: 0,
  errorClass: null,
  limitResetAt: null,
});

describe("(a) the parent tool's signal (M11R139)", () => {
  it("aborts the child, clears its expected origin and ends the row cancelled", async () => {
    const b = bed();
    const controller = new AbortController();
    const one = b.child("p1", "u1", controller.signal);
    controller.abort();
    expect(await one.guard.cancelled).toBe("stopped");
    expect(b.aborted).toEqual([one.childId]);
    expect(b.cleared).toEqual([one.childId]);
    expect(b.store.get(one.rowId)).toMatchObject({ state: "cancelled", reason: "stopped", endedAt: 7_000 });
    expect(one.guard.stopped()).toBe(true);
  });

  it("records the dispatcher's deadline as timeout", async () => {
    const b = bed();
    const controller = new AbortController();
    const one = b.child("p1", "u1", controller.signal);
    controller.abort("timeout");
    expect(await one.guard.cancelled).toBe("timeout");
    expect(b.store.get(one.rowId)?.reason).toBe("timeout");
  });

  it("stops at once a child whose call was cancelled before the guard was made", async () => {
    const b = bed();
    const controller = new AbortController();
    controller.abort();
    const one = b.child("p1", "u1", controller.signal);
    expect(await one.guard.cancelled).toBe("stopped");
    expect(b.aborted).toEqual([one.childId]);
  });
});

describe("(b) the parent's run ends (M11R139)", () => {
  it("aborts every running child of that parent and no other", async () => {
    const b = bed();
    const hook: { emit: ((event: RunEndEvent) => void) | null } = { emit: null };
    const stopWatching = b.stop.watch((listener) => {
      hook.emit = listener;
      return () => void (hook.emit = null);
    });
    const a = b.child("p1");
    const c = b.child("p1");
    const other = b.child("p2");
    hook.emit?.(runEnd("someone-else"));
    hook.emit?.(runEnd(a.childId));
    expect(b.aborted).toEqual([]);
    hook.emit?.(runEnd("p1"));
    expect(await a.guard.cancelled).toBe("parent_run_ended");
    expect(await c.guard.cancelled).toBe("parent_run_ended");
    expect(b.aborted.toSorted()).toEqual([a.childId, c.childId].toSorted());
    expect(b.store.get(a.rowId)).toMatchObject({ state: "cancelled", reason: "parent_run_ended" });
    expect(b.store.get(other.rowId)?.state).toBe("running");
    stopWatching();
    expect(hook.emit).toBeNull();
  });
});

describe("(c) the parent is archived or deleted (M11R139)", () => {
  it.each(["parent_archived", "parent_deleted"] as const)("aborts its children for %s", async (reason) => {
    const b = bed();
    const a = b.child("p1");
    const other = b.child("p2");
    expect(b.stop.cancelParent("p1", reason)).toBe(1);
    expect(await a.guard.cancelled).toBe(reason);
    expect(b.store.get(a.rowId)).toMatchObject({ state: "cancelled", reason });
    expect(b.store.get(other.rowId)?.state).toBe("running");
  });
});

describe("(d) the agent is quarantined (M11R139)", () => {
  it("aborts the children of the agent's parents for that owner only, and counts them", async () => {
    const b = bed({ p1: "atlas", p2: "atlas", p3: "nova" });
    const first = b.child("p1");
    const second = b.child("p2");
    const nova = b.child("p3");
    const stranger = b.child("p1", "u2");
    expect(b.stop.cancelAgent("u1", "atlas")).toBe(2);
    expect(await first.guard.cancelled).toBe("quarantined");
    expect(await second.guard.cancelled).toBe("quarantined");
    expect(b.store.get(first.rowId)).toMatchObject({ state: "cancelled", reason: "quarantined" });
    expect(b.store.get(nova.rowId)?.state).toBe("running");
    expect(b.store.get(stranger.rowId)?.state).toBe("running");
    expect(b.stop.cancelAgent("u1", "atlas")).toBe(0);
  });
});

describe("(f) the owner presses Stop on one child (M11R153)", () => {
  it("stops that run only, records `stopped` and answers true", async () => {
    const b = bed();
    const first = b.child("p1");
    const second = b.child("p1");
    expect(b.stop.cancelRun("u1", first.rowId)).toBe(true);
    expect(await first.guard.cancelled).toBe("stopped");
    expect(b.aborted).toEqual([first.childId]);
    expect(b.store.get(first.rowId)).toMatchObject({ state: "cancelled", reason: "stopped" });
    expect(b.store.get(second.rowId)?.state).toBe("running");
  });

  it("refuses another owner's run, an unknown one and one that already stopped", async () => {
    const b = bed();
    const one = b.child("p1");
    expect(b.stop.cancelRun("u2", one.rowId)).toBe(false);
    expect(b.stop.cancelRun("u1", "nope")).toBe(false);
    expect(b.aborted).toEqual([]);
    expect(b.stop.cancelRun("u1", one.rowId)).toBe(true);
    expect(b.stop.cancelRun("u1", one.rowId)).toBe(false);
    expect(b.aborted).toEqual([one.childId]);
  });
});

describe("the order of a stop (review M2)", () => {
  it("aborts the worker and answers the call even when the row cannot be written", async () => {
    const b = bed();
    const one = b.child("p1");
    b.db.run("DROP TABLE subagent_runs");
    expect(b.stop.cancelParent("p1", "parent_archived")).toBe(1);
    expect(await one.guard.cancelled).toBe("parent_archived");
    expect(b.aborted).toEqual([one.childId]);
    expect(b.cleared).toEqual([one.childId]);
  });

  it("stops a guard by name", async () => {
    const b = bed();
    const one = b.child("p1");
    one.guard.stop("parent_archived");
    expect(await one.guard.cancelled).toBe("parent_archived");
    expect(b.store.get(one.rowId)?.reason).toBe("parent_archived");
  });
});

describe("what is not stopped", () => {
  it("leaves a child that is done untouched", () => {
    const b = bed();
    const one = b.child("p1");
    b.store.finish(one.rowId, "done", null, 9_000);
    one.guard.release();
    expect(b.stop.cancelParent("p1", "parent_run_ended")).toBe(0);
    expect(b.aborted).toEqual([]);
    expect(b.store.get(one.rowId)).toMatchObject({ state: "done", endedAt: 9_000 });
  });

  it("stops a child once: a second cause adds nothing", async () => {
    const b = bed();
    const controller = new AbortController();
    const one = b.child("p1", "u1", controller.signal);
    b.stop.cancelParent("p1", "parent_archived");
    controller.abort();
    b.stop.cancelParent("p1", "parent_deleted");
    expect(await one.guard.cancelled).toBe("parent_archived");
    expect(b.aborted).toEqual([one.childId]);
    expect(b.store.get(one.rowId)?.reason).toBe("parent_archived");
  });

  it("ends the row even when the worker cannot be asked to abort", async () => {
    const b = bed();
    b.sessions.abort.mockRejectedValueOnce(new Error("gone"));
    const one = b.child("p1");
    b.stop.cancelParent("p1", "parent_archived");
    expect(await one.guard.cancelled).toBe("parent_archived");
    expect(b.store.get(one.rowId)?.state).toBe("cancelled");
  });
});

describe("(e) the daemon stops (M11R139)", () => {
  it("marks the rows a stopped daemon left starting or running interrupted at boot, and no other", () => {
    const b = bed();
    b.store.start({ id: "s", ownerId: "u1", parentSessionId: "p", profile: null, title: "T", startedAt: 1 });
    const running = b.child("p1");
    const done = b.child("p1");
    b.store.finish(done.rowId, "done", null, 2);
    expect(b.stop.boot()).toBe(2);
    expect(b.store.get("s")).toMatchObject({ state: "interrupted", reason: "restart", endedAt: 7_000 });
    expect(b.store.get(running.rowId)?.state).toBe("interrupted");
    expect(b.store.get(done.rowId)?.state).toBe("done");
  });
});
