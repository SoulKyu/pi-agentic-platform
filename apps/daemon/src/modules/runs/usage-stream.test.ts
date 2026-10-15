import { type EventFrame, UsageStreamEvent } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStreamHub, type StreamHub } from "../../kernel/ws/stream-hub.ts";
import { assistantEnd } from "./testing/events.ts";
import { openResumeBed as openBed, SESSION, type ResumeBed } from "./testing/resume-bed.ts";
import { createRunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";
import { createResume } from "./resume.ts";
import { createUsageStream, type UsageStream } from "./usage-stream.ts";

let t: ResumeBed;
let hub: StreamHub;
let usage: UsageStream;
let frames: EventFrame[];
let seq: number;

beforeEach(() => {
  t = openBed({ createRunsService, createRunsStore, createResume });
  hub = createStreamHub("e1", t.bed.clock);
  usage = createUsageStream({
    hub,
    clock: t.bed.clock,
    logger: t.bed.logger,
    runs: t.runs,
    port: t.runs.port,
    outbox: t.outbox,
    settings: () => ({ ...t.settings, timezone: null }),
  });
  frames = [];
  seq = 0;
});
afterEach(() => {
  usage.stop();
  t.close();
});

const subscribe = (owner = "u1") =>
  hub.open({
    connectionId: `c${++seq}`,
    sub: `sub${seq}`,
    stream: "usage",
    key: owner,
    after: undefined,
    send: (frame) => void frames.push(frame),
  });
const events = () => frames.map((frame) => UsageStreamEvent.parse(frame.event));
const limit = () => t.limitRun("usage limit. Try again in ~1 min.");

describe("the usage stream (M10R107)", () => {
  it("opens with the limited sessions, today's spend, the budget and auto-resume", () => {
    limit();
    t.limitRun("insufficient_quota", { id: "s2", ownerId: "u1" });
    t.limitRun("usage limit", { id: "s3", ownerId: "u2" });
    subscribe();
    const [snapshot] = events();
    expect(snapshot).toMatchObject({ kind: "snapshot", todayUsd: 0, budgetUsd: 5, autoResume: true });
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.limits.map((view) => view.sessionId)).toEqual(["s2", "s1"]);
    expect(snapshot.limits[1]).toMatchObject({ resume: "scheduled", provider: "anthropic" });
    expect(snapshot.limits[0]).toMatchObject({ resume: "none", resetAt: null });
  });

  it("lists a session only while its latest run is the limited one", () => {
    limit();
    t.startRun();
    subscribe();
    expect(events()[0]).toMatchObject({ kind: "snapshot", limits: [] });
  });

  it("caps the snapshot at 200 sessions", () => {
    for (let index = 0; index < 201; index++)
      t.bed.db.run(
        "INSERT INTO runs (id, owner_id, session_id, origin, status, started_at, ended_at) " +
          `VALUES ('r${index}', 'u1', 'x${index}', 'user', 'limited', ${index + 1}, ${index + 1})`,
      );
    subscribe();
    const [snapshot] = events();
    expect(snapshot?.kind === "snapshot" && snapshot.limits).toHaveLength(200);
  });

  it("says `limit` when a run ends limited, to its owner only", () => {
    subscribe();
    subscribe("u2");
    frames.length = 0;
    limit();
    const heard = events().filter((event) => event.kind === "limit");
    expect(heard).toEqual([
      {
        kind: "limit",
        limit: expect.objectContaining({ sessionId: "s1", resume: "scheduled", runId: "run-1" }),
      },
    ]);
    expect(frames).toHaveLength(heard.length + events().filter((event) => event.kind === "spend").length);
    expect(frames.every((frame) => frame.sub === "sub1")).toBe(true);
  });

  it("says `limit_cleared` when a later run starts, and nothing for a run after a plain one", () => {
    limit();
    subscribe();
    frames.length = 0;
    t.startRun();
    expect(events()).toEqual([{ kind: "limit_cleared", sessionId: "s1" }]);
    frames.length = 0;
    t.runs.observer.onRecord(SESSION, "run_end", {}, null);
    t.startRun();
    expect(events().filter((event) => event.kind === "limit_cleared")).toEqual([]);
  });

  it("says `limit` again with the resume cancelled after a cancel, the run staying limited", async () => {
    limit();
    subscribe();
    frames.length = 0;
    await t.resume.cancelResume("u1", "s1");
    usage.refresh("u1", "s1");
    expect(events()).toEqual([
      { kind: "limit", limit: expect.objectContaining({ sessionId: "s1", resume: "cancelled" }) },
    ]);
    frames.length = 0;
    subscribe();
    expect(JSON.stringify(events()[0])).toContain('"resume":"cancelled"');
  });

  it("sends `spend` at most once every 5 s, the last value arriving after the pause", async () => {
    subscribe();
    frames.length = 0;
    t.runs.port.expectOrigin("s1", { origin: "trigger", taskId: "t1" });
    t.startRun();
    const message = (cost: number) => t.runs.observer.onEvent("s1", assistantEnd({ cost }));
    message(1);
    message(0.5);
    message(0.25);
    const spends = () => events().filter((event) => event.kind === "spend");
    expect(spends()).toEqual([{ kind: "spend", todayUsd: 1, budgetUsd: 5 }]);
    await t.bed.clock.advance(4_999);
    expect(spends()).toHaveLength(1);
    await t.bed.clock.advance(1);
    expect(spends()).toEqual([
      { kind: "spend", todayUsd: 1, budgetUsd: 5 },
      { kind: "spend", todayUsd: 1.75, budgetUsd: 5 },
    ]);
    await t.bed.clock.advance(60_000);
    expect(spends()).toHaveLength(2);
  });

  it("does the work for nobody when nobody listens", async () => {
    t.runs.port.expectOrigin("s1", { origin: "trigger", taskId: "t1" });
    t.startRun();
    t.runs.observer.onEvent("s1", assistantEnd({ cost: 1 }));
    expect(t.bed.clock.pending()).toBe(0);
  });
});
