import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunsService, type RunsService } from "./service.ts";
import { createRunsStore, type RunRow, type RunsStore } from "./store.ts";
import { assistantEnd, compactionEnd, toolStart } from "./testing/events.ts";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";

let bed: RunsBed;
let store: RunsStore;
let service: RunsService;
let exported: RunRow[];
let counter: number;
const session = { id: "s1", ownerId: "u1" };

beforeEach(() => {
  bed = openRunsBed();
  store = createRunsStore(bed.db);
  exported = [];
  counter = 0;
  service = createRunsService({
    store,
    clock: bed.clock,
    logger: bed.logger,
    newId: () => `run-${++counter}`,
    exportRun: (row) => void exported.push(row),
  });
});
afterEach(() => bed.close());

const start = (origin = "user", id = session) => service.observer.onRecord(id, "run_start", { origin }, null);
const end = (data: unknown, loadout: Parameters<typeof service.observer.onRecord>[3] = null, id = session) =>
  service.observer.onRecord(id, "run_end", data, loadout);
const only = (): RunRow => {
  const rows = bed.db.all<{ id: string }>("SELECT id FROM runs ORDER BY started_at, id");
  expect(rows).toHaveLength(1);
  return store.get(rows[0]?.id ?? "") as RunRow;
};

describe("openTaskOf (Task 29b: the task a child's runs are tagged with)", () => {
  it("is the task of the session's open run, and null with no open run, an untagged run or another session", () => {
    expect(service.port.openTaskOf("s1")).toBeNull();
    service.port.expectOrigin("s1", { origin: "trigger", taskId: "t9" });
    start("user");
    expect(service.port.openTaskOf("s1")).toBe("t9");
    expect(service.port.openTaskOf("s2")).toBeNull();
    end({ aborted: false });
    expect(service.port.openTaskOf("s1")).toBeNull();
    start("user");
    expect(service.port.openTaskOf("s1")).toBeNull();
  });
});

describe("run boundaries", () => {
  it("opens a running row at run_start with the record's origin", () => {
    start("extension");
    expect(only()).toMatchObject({
      id: "run-1",
      status: "running",
      origin: "extension",
      taskId: null,
      ownerId: "u1",
      sessionId: "s1",
      endedAt: null,
    });
  });

  it("takes the origin and task id an expectation set, and consumes it", () => {
    expect(service.port.expectOrigin("s1", { origin: "trigger", taskId: "t1" })).toBe(true);
    start("user");
    end({ aborted: false });
    start("user");
    const rows = bed.db.all<{ origin: string; task_id: string | null }>(
      "SELECT origin, task_id FROM runs ORDER BY started_at, id",
    );
    expect(rows).toEqual([
      { origin: "trigger", task_id: "t1" },
      { origin: "user", task_id: null },
    ]);
  });

  it("ignores an expectation older than five minutes", async () => {
    service.port.expectOrigin("s1", { origin: "trigger", taskId: "t1" });
    await bed.clock.advance(5 * 60_000 + 1);
    start("user");
    expect(only()).toMatchObject({ origin: "user", taskId: null });
  });

  it("uses an expectation that is exactly five minutes old", async () => {
    service.port.expectOrigin("s1", { origin: "retry", taskId: "t1" });
    await bed.clock.advance(5 * 60_000);
    start("user");
    expect(only()).toMatchObject({ origin: "retry", taskId: "t1" });
  });

  it("refuses the 65th expectation, takes a replacement of one it holds, and frees the expired", async () => {
    for (let n = 0; n < 64; n++)
      expect(service.port.expectOrigin(`x${n}`, { origin: "trigger", taskId: "t" })).toBe(true);
    expect(service.port.expectOrigin("x64", { origin: "trigger", taskId: "t" })).toBe(false);
    expect(service.port.expectOrigin("x3", { origin: "manual", taskId: "t2" })).toBe(true);
    await bed.clock.advance(5 * 60_000 + 1);
    expect(service.port.expectOrigin("x64", { origin: "trigger", taskId: "t" })).toBe(true);
  });

  it("forgets an expectation that clearExpected withdraws", () => {
    service.port.expectOrigin("s1", { origin: "trigger", taskId: "t1" });
    service.port.clearExpected("s1");
    start("user");
    expect(only()).toMatchObject({ origin: "user", taskId: null });
  });

  it("falls back to user for an origin the record does not make sense of", () => {
    service.observer.onRecord(session, "run_start", { origin: 7 }, null);
    expect(only().origin).toBe("user");
  });

  it("closes a run that is still open when another starts in the same session", () => {
    start("user");
    start("user");
    const rows = bed.db.all<{ status: string; error_class: string | null }>(
      "SELECT status, error_class FROM runs ORDER BY id",
    );
    expect(rows).toEqual([
      { status: "interrupted", error_class: "crash" },
      { status: "running", error_class: null },
    ]);
  });

  it("ignores records of other kinds and events when no run is open", () => {
    service.observer.onRecord(session, "worker_exit", {}, null);
    service.observer.onEvent("s1", assistantEnd({ input: 5, cost: 1 }));
    expect(bed.db.all("SELECT 1 FROM runs")).toHaveLength(0);
    expect(service.port.sessionCost("s1")).toBeNull();
  });
});

describe("usage", () => {
  it("adds assistant messages up and keeps the last model and provider", () => {
    start();
    service.observer.onEvent(
      "s1",
      assistantEnd(
        { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.5 },
        { provider: "a", model: "m1" },
      ),
    );
    service.observer.onEvent(
      "s1",
      assistantEnd(
        { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25 },
        { provider: "b", model: "m2" },
      ),
    );
    end({ aborted: false }, { billing: "api" });
    expect(only()).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
      costUsd: 0.75,
      turns: 2,
      provider: "b",
      model: "m2",
      billing: "api",
      status: "completed",
    });
  });

  it("ignores a system message and a user message", () => {
    start();
    const base = assistantEnd({ input: 99, cost: 9 });
    for (const role of ["system", "user", "toolResult"])
      service.observer.onEvent("s1", { ...base, message: { ...(base.message as object), role } });
    end({ aborted: false });
    expect(only()).toMatchObject({ inputTokens: 0, costUsd: 0, turns: 0 });
  });

  it("counts a tool call and not a nested one", () => {
    start();
    service.observer.onEvent("s1", toolStart());
    service.observer.onEvent("s1", toolStart(true));
    service.observer.onEvent("s1", toolStart());
    end({ aborted: false });
    expect(only().toolCalls).toBe(2);
  });

  it("adds a compaction's usage to the open run without counting a turn, and nothing for one without a result", () => {
    start();
    service.observer.onEvent("s1", compactionEnd({ usage: { input: 100, output: 7, cost: 0.5 } }));
    service.observer.onEvent("s1", compactionEnd(undefined));
    service.observer.onEvent("s1", compactionEnd({}));
    end({ aborted: false });
    expect(only()).toMatchObject({ inputTokens: 100, outputTokens: 7, costUsd: 0.5, turns: 0 });
  });

  it("drops figures a provider got wrong rather than store them", () => {
    start();
    const event = assistantEnd({ input: 5, cost: 1 });
    const message = event.message as { usage: { input: unknown; output: unknown; cost: { total: unknown } } };
    message.usage.input = -3;
    message.usage.output = "7";
    message.usage.cost.total = Number.NaN;
    service.observer.onEvent("s1", event);
    end({ aborted: false });
    expect(only()).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 1 });
  });

  it("keeps the figures of a run in the row as it goes, so a crash does not lose them", () => {
    start();
    service.observer.onEvent("s1", assistantEnd({ input: 10, cost: 0.5 }));
    expect(only()).toMatchObject({
      status: "running",
      inputTokens: 10,
      costUsd: 0.5,
      model: "claude-sonnet",
    });
  });

  it("keeps the error text in memory only, cut to 2 KiB", () => {
    start();
    service.observer.onEvent("s1", assistantEnd({}, { stopReason: "error", errorMessage: "e".repeat(5000) }));
    expect(service.peek("s1")).toMatchObject({ stopReason: "error", errorMessage: "e".repeat(2048) });
    expect(JSON.stringify(bed.db.all("SELECT * FROM runs"))).not.toContain("eeee");
  });

  it("says the cost of the run to the live listeners after each message and compaction", () => {
    const seen: Array<[string, string, number]> = [];
    service.port.onLiveCost((sessionId, ownerId, cost) => seen.push([sessionId, ownerId, cost]));
    start();
    service.observer.onEvent("s1", assistantEnd({ cost: 0.5 }));
    service.observer.onEvent("s1", compactionEnd({ usage: { cost: 0.25 } }));
    expect(seen).toEqual([
      ["s1", "u1", 0.5],
      ["s1", "u1", 0.75],
    ]);
  });
});

describe("how a run ends", () => {
  it("is cancelled with the class aborted when the person stopped it", () => {
    start();
    end({ aborted: true });
    expect(only()).toMatchObject({ status: "cancelled", errorClass: "aborted" });
  });

  it("is interrupted with the class crash when the worker died", () => {
    start();
    end({ interrupted: "killed" });
    expect(only()).toMatchObject({ status: "interrupted", errorClass: "crash" });
  });

  it("is failed with the class provider when the last message ended in error", () => {
    start();
    service.observer.onEvent("s1", assistantEnd({}, { stopReason: "error", errorMessage: "boom" }));
    end({ aborted: false });
    expect(only()).toMatchObject({ status: "failed", errorClass: "provider" });
  });

  it("is completed when a later message ended well after an error", () => {
    start();
    service.observer.onEvent("s1", assistantEnd({}, { stopReason: "error" }));
    service.observer.onEvent("s1", assistantEnd({}, { stopReason: "stop" }));
    end({ aborted: false });
    expect(only().status).toBe("completed");
  });

  it("is cancelled with the runner's class when markEnding tagged the session", () => {
    start();
    service.port.markEnding("s1", "deadline");
    end({ aborted: true });
    expect(only()).toMatchObject({ status: "cancelled", errorClass: "deadline" });
    expect(exported[0]).toMatchObject({ errorClass: "deadline" });
  });

  it("drops a tag on a session with no open run", () => {
    service.port.markEnding("s1", "budget");
    start();
    end({ aborted: true });
    expect(only().errorClass).toBe("aborted");
  });

  it("stores the billing the loadout says and unknown without one", () => {
    start();
    end({ aborted: false }, { billing: "subscription" });
    start();
    end({ aborted: false });
    const rows = bed.db.all<{ billing: string }>("SELECT billing FROM runs ORDER BY started_at, rowid");
    expect(rows.map((row) => row.billing).sort()).toEqual(["subscription", "unknown"]);
  });

  it("exports the finished run once, with its figures", () => {
    start();
    service.observer.onEvent("s1", assistantEnd({ input: 3, cost: 0.5 }));
    end({ aborted: false });
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      id: "run-1",
      status: "completed",
      inputTokens: 3,
      costUsd: 0.5,
      endedAt: bed.clock.now(),
    });
  });

  it("tells the end listeners and the start listeners", () => {
    const events: unknown[] = [];
    service.port.onRunStart((event) => events.push(["start", event]));
    service.port.onRunEnd((event) => events.push(["end", event]));
    service.port.expectOrigin("s1", { origin: "trigger", taskId: "t1" });
    start();
    service.observer.onEvent("s1", assistantEnd({ cost: 0.5 }));
    end({ aborted: false });
    expect(events).toEqual([
      ["start", { runId: "run-1", sessionId: "s1", ownerId: "u1", taskId: "t1", origin: "trigger" }],
      [
        "end",
        {
          runId: "run-1",
          sessionId: "s1",
          ownerId: "u1",
          taskId: "t1",
          origin: "trigger",
          status: "completed",
          costUsd: 0.5,
          errorClass: null,
          limitResetAt: null,
        },
      ],
    ]);
  });
});

describe("a failing observer never reaches the session", () => {
  it("logs a throwing listener and still runs the next one", () => {
    const later: string[] = [];
    service.port.onRunEnd(() => {
      throw new Error("listener bug");
    });
    service.port.onRunEnd((event) => later.push(event.runId));
    start();
    expect(() => end({ aborted: false })).not.toThrow();
    expect(later).toEqual(["run-1"]);
    expect(bed.logs.filter((line) => line.msg === "runs_listener_failed")).toHaveLength(1);
  });

  it("logs a store failure once a minute and keeps going", async () => {
    bed.db.exec("DROP TABLE runs");
    expect(() => start()).not.toThrow();
    expect(() => start()).not.toThrow();
    expect(bed.logs.filter((line) => line.msg === "runs_observer_failed")).toHaveLength(1);
    await bed.clock.advance(60_000);
    start();
    expect(bed.logs.filter((line) => line.msg === "runs_observer_failed")).toHaveLength(2);
  });

  it("does not fail the run when the export throws, and logs it", () => {
    const failing = createRunsService({
      store,
      clock: bed.clock,
      logger: bed.logger,
      newId: () => "run-x",
      exportRun: () => {
        throw new Error("disk full");
      },
    });
    failing.observer.onRecord(session, "run_start", { origin: "user" }, null);
    expect(() => failing.observer.onRecord(session, "run_end", { aborted: false }, null)).not.toThrow();
    expect(store.get("run-x")?.status).toBe("completed");
    expect(bed.logs.filter((line) => line.msg === "runs_export_failed")).toHaveLength(1);
  });

  it("bounds what the logged error holds", () => {
    bed.db.exec("DROP TABLE runs");
    start();
    const line = bed.logs.find((entry) => entry.msg === "runs_observer_failed");
    expect(JSON.stringify(line).length).toBeLessThan(600);
  });
});
