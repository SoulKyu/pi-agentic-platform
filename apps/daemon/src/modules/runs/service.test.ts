import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunsService, type RunsService } from "./service.ts";
import { createRunsStore, type RunRow, type RunsStore } from "./store.ts";
import { assistantEnd } from "./testing/events.ts";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";

let bed: RunsBed;
let store: RunsStore;
let service: RunsService;
let exported: RunRow[];
let counter: number;

beforeEach(() => {
  bed = openRunsBed();
  store = createRunsStore(bed.db);
  exported = [];
  counter = 0;
  service = createRunsService({
    store,
    clock: bed.clock,
    logger: bed.logger,
    newId: () => `live-${++counter}`,
    exportRun: (row) => void exported.push(row),
  });
});
afterEach(() => bed.close());

const at = (iso: string) => Date.parse(iso);
const add = (
  id: string,
  startedAt: number,
  cost: number,
  extra: Partial<Parameters<RunsStore["insertRunning"]>[0]> & {
    model?: string;
    provider?: string;
    end?: boolean;
    endedAt?: number;
  } = {},
) => {
  const { model = "m", provider = "p", end = true, endedAt = startedAt + 1000, ...rest } = extra;
  store.insertRunning({
    id,
    ownerId: "u1",
    sessionId: "s1",
    taskId: null,
    origin: "user",
    startedAt,
    ...rest,
  });
  const progress = {
    provider,
    model,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    costUsd: cost,
    turns: 1,
    toolCalls: 0,
  };
  if (end)
    store.finish(id, {
      ...progress,
      status: "completed",
      endedAt,
      billing: "api",
      errorClass: null,
      limitResetAt: null,
    });
  else store.saveProgress(id, progress);
};

describe("recovery at boot", () => {
  it("turns running rows into interrupted runs ended now, and writes their lines", () => {
    add("a", bed.clock.now() - 5000, 0.5, { end: false, taskId: "t" });
    add("done", bed.clock.now() - 9000, 1);
    expect(service.recover()).toBe(1);
    expect(store.get("a")).toMatchObject({
      status: "interrupted",
      errorClass: "crash",
      endedAt: bed.clock.now(),
      costUsd: 0.5,
    });
    expect(store.get("done")?.status).toBe("completed");
    expect(exported.map((row) => row.id)).toEqual(["a"]);
    expect(service.recover()).toBe(0);
  });
});

describe("spentToday", () => {
  it("counts from local midnight in the owner's zone", () => {
    // Now is 2026-10-14T12:00Z: Paris midnight was 2026-10-13T22:00Z, UTC midnight 2026-10-14T00:00Z.
    add("before-paris", at("2026-10-13T21:59:00Z"), 1, { taskId: "t", origin: "trigger" });
    add("after-paris", at("2026-10-13T22:01:00Z"), 2, { taskId: "t", origin: "trigger" });
    add("after-utc", at("2026-10-14T00:01:00Z"), 4, { taskId: "t", origin: "trigger" });
    expect(service.port.spentToday("u1", "Europe/Paris")).toBe(6);
    expect(service.port.spentToday("u1", "UTC")).toBe(4);
  });

  it("counts a finished run by when it ended: one that crosses local midnight does not lower today's total", () => {
    const started = at("2026-10-13T23:50:00Z");
    add("crossing", started, 3, { taskId: "t", origin: "trigger", end: false });
    // Started yesterday, ended just after UTC midnight: the started_at filter would drop it from today's total.
    store.finish("crossing", {
      provider: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      costUsd: 3,
      turns: 1,
      toolCalls: 0,
      status: "completed",
      endedAt: at("2026-10-14T00:10:00Z"),
      billing: "api",
      errorClass: null,
      limitResetAt: null,
    });
    expect(service.port.spentToday("u1", "UTC")).toBe(3);
  });

  it("counts trigger, manual, retry and resume runs and not user ones, and only the owner's", () => {
    const base = at("2026-10-14T08:00:00Z");
    add("trigger", base, 1, { taskId: "t1", origin: "trigger" });
    add("manual", base, 2, { taskId: "t2", origin: "manual" });
    add("retry", base, 4, { taskId: "t3", origin: "retry" });
    add("resume", base, 8, { taskId: "t4", origin: "resume" });
    add("user", base, 16);
    add("extension", base, 32, { origin: "extension" });
    add("someone-else", base, 64, { ownerId: "u2", taskId: "t1", origin: "trigger" });
    expect(service.port.spentToday("u1", "UTC")).toBe(15);
  });

  it("adds the live cost of a run in flight", () => {
    add("done", at("2026-10-14T08:00:00Z"), 1, { taskId: "t1", origin: "trigger" });
    service.port.expectOrigin("s9", { origin: "trigger", taskId: "t9" });
    service.observer.onRecord({ id: "s9", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    service.observer.onEvent("s9", assistantEnd({ cost: 0.5 }));
    expect(service.port.spentToday("u1", "UTC")).toBe(1.5);
    service.observer.onEvent("s9", assistantEnd({ cost: 0.25 }));
    expect(service.port.spentToday("u1", "UTC")).toBe(1.75);
    service.observer.onRecord({ id: "s9", ownerId: "u1" }, "run_end", { aborted: false }, null);
    expect(service.port.spentToday("u1", "UTC")).toBe(1.75);
  });

  it("does not count a user's own run in flight, and counts a resume in flight", () => {
    service.observer.onRecord({ id: "s8", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    service.observer.onEvent("s8", assistantEnd({ cost: 3 }));
    service.port.expectOrigin("s7", { origin: "resume", taskId: "t7" });
    service.observer.onRecord({ id: "s7", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    service.observer.onEvent("s7", assistantEnd({ cost: 5 }));
    expect(service.port.spentToday("u1", "UTC")).toBe(5);
    expect(service.port.spentToday("u2", "UTC")).toBe(0);
  });

  it("spentTodayOf limits the sum to a trigger's own tasks, live runs included", () => {
    const base = at("2026-10-14T08:00:00Z");
    add("a", base, 1, { taskId: "t1", origin: "trigger" });
    add("b", base, 2, { taskId: "t2", origin: "trigger" });
    service.port.expectOrigin("s9", { origin: "manual", taskId: "t1" });
    service.observer.onRecord({ id: "s9", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    service.observer.onEvent("s9", assistantEnd({ cost: 0.5 }));
    expect(service.port.spentTodayOf("u1", "UTC", ["t1"])).toBe(1.5);
    expect(service.port.spentTodayOf("u1", "UTC", ["t1", "t2"])).toBe(3.5);
    expect(service.port.spentTodayOf("u1", "UTC", [])).toBe(0);
    expect(service.port.spentTodayOf("u1", "UTC", ["t3"])).toBe(0);
  });
});

describe("sessionCost", () => {
  it("is null for a session without runs", () => {
    expect(service.port.sessionCost("s1")).toBeNull();
  });

  it("is the finished runs plus the live cost of the open one", () => {
    add("a", at("2026-10-14T08:00:00Z"), 0.5);
    add("b", at("2026-10-14T09:00:00Z"), 0.25);
    expect(service.port.sessionCost("s1")).toBe(0.75);
    service.observer.onRecord({ id: "s1", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    expect(service.port.sessionCost("s1")).toBe(0.75);
    service.observer.onEvent("s1", assistantEnd({ cost: 0.125 }));
    expect(service.port.sessionCost("s1")).toBe(0.875);
  });

  it("is the open run's cost alone for a session whose first run is still going", () => {
    service.observer.onRecord({ id: "s5", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    expect(service.port.sessionCost("s5")).toBe(0);
    service.observer.onEvent("s5", assistantEnd({ cost: 0.5 }));
    expect(service.port.sessionCost("s5")).toBe(0.5);
  });

  it("is a number again once the open run is closed, without counting it twice", () => {
    service.observer.onRecord({ id: "s5", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    service.observer.onEvent("s5", assistantEnd({ cost: 0.5 }));
    service.observer.onRecord({ id: "s5", ownerId: "u1" }, "run_end", { aborted: false }, null);
    expect(service.port.sessionCost("s5")).toBe(0.5);
  });
});

describe("summary", () => {
  it("carries the observability facts it was given, never a token or a header", () => {
    const wired = createRunsService({
      store,
      clock: bed.clock,
      logger: bed.logger,
      newId: () => "x",
      exportRun: () => {},
      observability: { metrics: true, otlpHost: "otel.example.net:4318" },
    });
    const summary = wired.port.summary("u1", "today", "UTC");
    expect(summary.metrics).toBe(true);
    expect(summary.otlpHost).toBe("otel.example.net:4318");
  });

  it("buckets by origin and by model over the range", () => {
    add("a", at("2026-10-14T08:00:00Z"), 1, { origin: "trigger", taskId: "t", model: "m1" });
    add("b", at("2026-10-14T09:00:00Z"), 2, { model: "m2" });
    add("c", at("2026-10-14T10:00:00Z"), 4, { model: "m2" });
    add("old", at("2026-10-01T10:00:00Z"), 8, { model: "m3" });
    const summary = service.port.summary("u1", "today", "UTC");
    expect(summary).toEqual({
      from: at("2026-10-14T00:00:00Z"),
      to: bed.clock.now(),
      timeZone: "UTC",
      totals: { costUsd: 7, tokens: 12, runs: 3 },
      byOrigin: [
        { origin: "user", costUsd: 6, tokens: 8, runs: 2 },
        { origin: "trigger", costUsd: 1, tokens: 4, runs: 1 },
      ],
      byModel: [
        { provider: "p", model: "m2", billing: "api", costUsd: 6, tokens: 8, runs: 2 },
        { provider: "p", model: "m1", billing: "api", costUsd: 1, tokens: 4, runs: 1 },
      ],
      metrics: false,
      otlpHost: null,
    });
    expect(service.port.summary("u1", "30d", "UTC").totals).toEqual({ costUsd: 15, tokens: 16, runs: 4 });
    expect(service.port.summary("u1", "7d", "UTC").totals.runs).toBe(3);
    expect(service.port.summary("u2", "30d", "UTC").totals).toEqual({ costUsd: 0, tokens: 0, runs: 0 });
  });

  it("keeps the 50 dearest models and sums the rest as other", () => {
    for (let n = 0; n < 53; n++) add(`r${n}`, at("2026-10-14T08:00:00Z") + n, n + 1, { model: `model-${n}` });
    const { byModel, totals } = service.port.summary("u1", "today", "UTC");
    expect(byModel).toHaveLength(51);
    expect(byModel[0]).toMatchObject({ model: "model-52", costUsd: 53 });
    expect(byModel[49]).toMatchObject({ model: "model-3", costUsd: 4 });
    expect(byModel[50]).toEqual({
      provider: "other",
      model: "other",
      billing: "unknown",
      costUsd: 6,
      tokens: 12,
      runs: 3,
    });
    expect(byModel.reduce((sum, row) => sum + row.costUsd, 0)).toBe(totals.costUsd);
  });

  it("names the server's zone when the setting has none", () => {
    expect(service.port.summary("u1", "today", null).timeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });
});

describe("onResumeSkipped", () => {
  it("tells the listeners, isolated from each other", () => {
    const seen: string[] = [];
    service.port.onResumeSkipped(() => {
      throw new Error("bug");
    });
    service.port.onResumeSkipped((sessionId, reason) => seen.push(`${sessionId}:${reason}`));
    service.resumeSkipped("s1", "budget");
    expect(seen).toEqual(["s1:budget"]);
  });
});

describe("sessionBilling (the compare column's API-equivalent label, agreement 14)", () => {
  const finishAs = (id: string, billing: "api" | "subscription" | "unknown") => {
    add(id, at("2026-10-14T08:00:00Z"), 0.5, { end: false });
    store.finish(id, {
      provider: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      costUsd: 0.5,
      turns: 1,
      toolCalls: 0,
      status: "completed",
      endedAt: at("2026-10-14T08:01:00Z"),
      billing,
      errorClass: null,
      limitResetAt: null,
    });
  };

  it("is null for a session without runs and unknown while only an open run exists", () => {
    expect(service.port.sessionBilling("s1")).toBeNull();
    service.observer.onRecord({ id: "s9", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    expect(service.port.sessionBilling("s9")).toBe("unknown");
  });

  it("is api, subscription (any subscription run wins) or unknown from the finished runs", () => {
    finishAs("a", "unknown");
    expect(service.port.sessionBilling("s1")).toBe("unknown");
    finishAs("b", "api");
    expect(service.port.sessionBilling("s1")).toBe("api");
    finishAs("c", "subscription");
    expect(service.port.sessionBilling("s1")).toBe("subscription");
  });
});
