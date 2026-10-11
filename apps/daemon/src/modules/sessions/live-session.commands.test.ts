import { PapError, type SessionStreamEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);
const activities = (published: SessionStreamEvent[]) =>
  published.flatMap((event) => (event.kind === "activity" ? [event.activity] : []));
const sentTypes = (worker: { requests: Array<{ type: string }> }) => worker.requests.map((r) => r.type);

describe("activity", () => {
  it("publishes compaction_start and compaction_end", async () => {
    const { published, worker, live } = setup();
    worker.emit(piEvent({ type: "compaction_start", reason: "manual" }));
    expect(live.activity()).toEqual({ compacting: true, retry: null });
    worker.emit(piEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false }));
    expect(activities(published)).toEqual([
      { compacting: true, retry: null },
      { compacting: false, retry: null },
    ]);
  });

  it("publishes the attempt of an automatic retry until the run starts", () => {
    const { published, worker } = setup();
    worker.emit(
      piEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1, errorMessage: "x" }),
    );
    worker.emit(piEvent({ type: "agent_start" }));
    expect(activities(published)).toEqual([
      { compacting: false, retry: { attempt: 2, maxAttempts: 3 } },
      { compacting: false, retry: null },
    ]);
  });

  it("is idle again, and says so, once the worker is gone", async () => {
    const { live, worker, clock } = setup();
    worker.emit(piEvent({ type: "compaction_start", reason: "manual" }));
    worker.crash({ code: 1, signal: null, cause: "exit_code" });
    await clock.advance(0);
    expect(live.activity()).toEqual({ compacting: false, retry: null });
    expect(live.busy()).toBe(false);
  });
});

describe("a prompt while the session compacts (M2R89)", () => {
  it("throws session_busy and sends nothing", async () => {
    const { live, worker } = setup();
    worker.emit(piEvent({ type: "compaction_start", reason: "threshold" }));
    await expect(live.prompt("go")).rejects.toThrow(new PapError("session_busy"));
    await expect(live.prompt("steer", "steer")).rejects.toThrow(new PapError("session_busy"));
    expect(sentTypes(worker)).toEqual([]);
    expect(live.queue().count).toBe(0);
  });

  it("throws session_busy while a compact command is in flight, and counts nothing", async () => {
    const { live, worker, clock } = setup({ hold: ["compact"] });
    const compacting = live.command({ type: "compact" });
    expect(live.commandsInFlight()).toBe(1);
    await expect(live.prompt("go")).rejects.toThrow(new PapError("session_busy"));
    expect(sentTypes(worker)).toEqual(["compact"]);
    worker.respond(worker.requests[0]?.id ?? "", { data: {} });
    await compacting;
    await clock.advance(0);
    expect(live.commandsInFlight()).toBe(0);
    await expect(live.prompt("now")).resolves.toEqual({ disposition: "started" });
  });
});

describe("busy", () => {
  it("is false for an idle session and true for each reason in turn", async () => {
    const { live, worker, clock } = setup({ hold: ["navigate_tree"], holdPrompt: true });
    expect(live.busy()).toBe(false);
    worker.emit(piEvent({ type: "compaction_start", reason: "manual" }));
    expect(live.busy()).toBe(true);
    worker.emit(piEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false }));
    expect(live.busy()).toBe(false);
    const prompted = live.prompt("go");
    expect(live.busy()).toBe(true);
    worker.respond(worker.requests[0]?.id ?? "", { data: { disposition: "handled" } });
    await prompted;
    await clock.advance(0);
    expect(live.busy()).toBe(false);
    const navigating = live.command({ type: "navigate_tree", targetId: "e1" });
    expect(live.busy()).toBe(true);
    worker.respond(worker.requests.at(-1)?.id ?? "", { data: {} });
    await navigating;
    expect(live.busy()).toBe(false);
    worker.emit(piEvent({ type: "agent_start" }));
    expect(live.busy()).toBe(true);
  });
});

describe("navigated", () => {
  it("sets the leaf, and an id over 128 characters counts as unknown", () => {
    const { live } = setup({ leafId: "u9" });
    live.navigated("a0");
    expect(live.leafId()).toBe("a0");
    live.navigated("x".repeat(129));
    expect(live.leafId()).toBeNull();
    live.navigated(null);
    expect(live.leafId()).toBeNull();
  });
});
