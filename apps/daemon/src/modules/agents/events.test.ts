import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentEvents, EVENTS_PER_AGENT, SUMMARY_CHARS } from "./events.ts";
import { createAgentsBed, type AgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const AGENT = "atlas-0000";
const card = (over: Partial<Parameters<ReturnType<typeof createAgentEvents>["isolated"]>[3]> = {}) => ({
  title: "Nightly",
  state: "done" as const,
  source: "webhook",
  tainted: true,
  scratch: "/pap/agents/.runs/atlas-0000/0b1c2d3e-0001-4000-8000-000000000001",
  summary: "All good.",
  durationMs: 4_000,
  costUsd: 0.25,
  ...over,
});

function setup() {
  bed = createAgentsBed();
  bed.db.run(
    `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
     VALUES ($id, 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    { id: AGENT },
  );
  const bump = vi.fn();
  const events = createAgentEvents({ db: bed.db, clock: bed.clock, logger: silent(), unread: { bump } });
  return { events, bump };
}
const silent = () => ({ warn: vi.fn() }) as never;
const rows = () =>
  bed.db.all<{ kind: string; task_id: string | null; data: string; at: number; owner_id: string }>(
    "SELECT kind, task_id, data, at, owner_id FROM agent_events ORDER BY id",
  );

describe("the isolated run's card (M11R69)", () => {
  it("writes one row of kind isolated and counts it unread once", () => {
    const { events, bump } = setup();
    expect(events.isolated("u1", AGENT, "task-1", card())).toBe(true);
    const [row] = rows();
    expect(row).toMatchObject({ kind: "isolated", task_id: "task-1", owner_id: "u1", at: bed.clock.now() });
    expect(JSON.parse(row?.data ?? "")).toEqual(card());
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith("u1", AGENT);
  });

  it("strips hidden characters from the summary and clips it to 2 000 characters", () => {
    const { events } = setup();
    events.isolated("u1", AGENT, "task-1", card({ summary: "ok\u202e\u200b\u0007 done\ttab\nline" }));
    expect(JSON.parse(rows()[0]?.data ?? "").summary).toBe("ok done\ttab\nline");
    events.isolated("u1", AGENT, "task-2", card({ summary: "é".repeat(SUMMARY_CHARS + 500) }));
    expect([...JSON.parse(rows()[1]?.data ?? "").summary]).toHaveLength(SUMMARY_CHARS);
    expect(SUMMARY_CHARS).toBe(2_000);
  });

  it("takes a run with no assistant text: the summary is empty", () => {
    const { events } = setup();
    events.isolated("u1", AGENT, "task-1", card({ summary: null }));
    expect(JSON.parse(rows()[0]?.data ?? "").summary).toBe("");
  });

  it("writes nothing for another owner's agent or one that is gone, and counts nothing", () => {
    const { events, bump } = setup();
    expect(events.isolated("u2", AGENT, "task-1", card())).toBe(false);
    expect(events.isolated("u1", "ghost-0000", "task-1", card())).toBe(false);
    expect(rows()).toEqual([]);
    expect(bump).not.toHaveBeenCalled();
  });

  it("refuses a state that has no card: a cancelled run writes none", () => {
    const { events, bump } = setup();
    expect(events.isolated("u1", AGENT, "task-1", card({ state: "cancelled" as never }))).toBe(false);
    expect(rows()).toEqual([]);
    expect(bump).not.toHaveBeenCalled();
  });

  it("keeps the newest 500 cards of an agent and drops the older ones", () => {
    const { events } = setup();
    for (let n = 0; n < EVENTS_PER_AGENT + 3; n += 1) events.isolated("u1", AGENT, `task-${n}`, card());
    const kept = rows();
    expect(kept).toHaveLength(EVENTS_PER_AGENT);
    expect(kept[0]?.task_id).toBe("task-3");
    expect(kept.at(-1)?.task_id).toBe(`task-${EVENTS_PER_AGENT + 2}`);
    expect(EVENTS_PER_AGENT).toBe(500);
  });

  it("a failing unread counter never undoes the card, and is said", () => {
    const { events } = setup();
    const warn = vi.fn();
    const failing = createAgentEvents({
      db: bed.db,
      clock: bed.clock,
      logger: { warn } as never,
      unread: {
        bump: () => {
          throw new Error("boom");
        },
      },
    });
    expect(failing.isolated("u1", AGENT, "task-1", card())).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("agent_event_unread_failed", expect.anything());
    expect(events).toBeDefined();
  });
});

describe("the cards of a thread task (M11R71, M11R72)", () => {
  const run = { title: "Morning round", state: "running" as const };
  const withHint = () => {
    const base = setup();
    const written = vi.fn();
    const events = createAgentEvents({
      db: bed.db,
      clock: bed.clock,
      logger: silent(),
      unread: { bump: base.bump },
      written,
    });
    return { ...base, events, written };
  };

  it("writes a schedule card, counts it unread, and tells the open tab with the card's id", () => {
    const { events, bump, written } = withHint();
    const id = events.runCard("u1", AGENT, "task-1", "schedule", run);
    expect(id).toBeGreaterThan(0);
    expect(rows()[0]).toMatchObject({ kind: "schedule", task_id: "task-1", owner_id: "u1" });
    expect(JSON.parse(rows()[0]?.data ?? "")).toEqual(run);
    expect(bump).toHaveBeenCalledWith("u1", AGENT);
    expect(written).toHaveBeenCalledWith("u1", AGENT, id);
  });

  it("refuses a card whose data is not the kind's shape, and a card for an agent that is not the owner's", () => {
    const { events, bump, written } = withHint();
    expect(events.runCard("u1", AGENT, "t", "task", { ...run, title: "" })).toBeNull();
    expect(events.runCard("u1", AGENT, "t", "task", { ...run, state: "paused" as never })).toBeNull();
    expect(events.runCard("u1", AGENT, "t", "task", { ...run, extra: 1 } as never)).toBeNull();
    expect(events.runCard("u2", AGENT, "t", "task", run)).toBeNull();
    expect(rows()).toEqual([]);
    expect(bump).not.toHaveBeenCalled();
    expect(written).not.toHaveBeenCalled();
  });

  it("validates each kind: a reminder, a delegation and a notification", () => {
    const { events } = withHint();
    expect(events.write("u1", AGENT, "reminder", null, { note: "call back", setAt: 5 })).not.toBeNull();
    expect(events.write("u1", AGENT, "reminder", null, { note: "x".repeat(2001), setAt: 5 })).toBeNull();
    expect(events.write("u1", AGENT, "notify", null, { text: "x".repeat(501), itemId: "i1" })).toBeNull();
    expect(events.write("u1", AGENT, "notify", "t", { text: "ready", itemId: "i1" })).not.toBeNull();
    const delegation = {
      fromAgentId: "birch-3c4d",
      fromName: "Birch",
      state: "done",
      summary: "ok",
      clipped: false,
      tainted: true,
      isolated: true,
    };
    expect(events.write("u1", AGENT, "delegation", "t", delegation)).not.toBeNull();
    expect(
      events.write("u1", AGENT, "delegation", "t", { ...delegation, summary: "x".repeat(16_001) }),
    ).toBeNull();
  });

  it("moves the card of the task to the state it ended with and keeps its place", () => {
    const { events, bump, written } = withHint();
    const id = events.runCard("u1", AGENT, "task-1", "schedule", run) as number;
    const at = rows()[0]?.at;
    bump.mockClear();
    written.mockClear();
    expect(
      events.runCardEnded("u1", AGENT, "task-1", {
        state: "done",
        durationMs: 4_000,
        costUsd: 0.2,
        billing: "api",
      }),
    ).toBe(true);
    expect(JSON.parse(rows()[0]?.data ?? "")).toEqual({
      title: "Morning round",
      state: "done",
      durationMs: 4_000,
      costUsd: 0.2,
      billing: "api",
    });
    expect(rows()[0]?.at).toBe(at);
    expect(rows()).toHaveLength(1);
    expect(written).toHaveBeenCalledWith("u1", AGENT, id);
    // A success is not unread again: the reply is.
    expect(bump).not.toHaveBeenCalled();
  });

  it("counts a failed card unread again, and says nothing of a task that has no card", () => {
    const { events, bump } = withHint();
    events.runCard("u1", AGENT, "task-1", "task", run);
    bump.mockClear();
    expect(events.runCardEnded("u1", AGENT, "task-1", { state: "failed" })).toBe(true);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(events.runCardEnded("u1", AGENT, "ghost", { state: "failed" })).toBe(false);
    expect(events.runCardEnded("u2", AGENT, "task-1", { state: "done" })).toBe(false);
  });

  it("moves only the schedule or task card of that task, the newest first", () => {
    const { events } = withHint();
    events.isolated("u1", AGENT, "task-1", card());
    events.runCard("u1", AGENT, "task-1", "task", run);
    events.runCardEnded("u1", AGENT, "task-1", { state: "done" });
    expect(rows().map((row) => [row.kind, JSON.parse(row.data).state])).toEqual([
      ["isolated", "done"],
      ["task", "done"],
    ]);
  });
});

describe("the page of cards (M11R72)", () => {
  const fill = (events: ReturnType<typeof createAgentEvents>, count: number) => {
    for (let n = 0; n < count; n += 1) {
      events.runCard("u1", AGENT, `task-${n}`, "task", { title: `Task ${n}`, state: "done" });
    }
  };

  it("gives 100 a page, newest first, and the next page from the last card's at and id", async () => {
    const { events } = setup();
    for (let n = 0; n < 130; n += 1) {
      events.runCard("u1", AGENT, `task-${n}`, "task", { title: `Task ${n}`, state: "done" });
      if (n % 10 === 9) await bed.clock.advance(1_000);
    }
    const first = events.list("u1", AGENT);
    expect(first.events).toHaveLength(100);
    expect(first.more).toBe(true);
    expect(first.events[0]).toMatchObject({ kind: "task", taskId: "task-129", data: { title: "Task 129" } });
    const last = first.events[99];
    const second = events.list("u1", AGENT, { at: last?.at ?? 0, id: last?.id ?? 0 });
    expect(second.events).toHaveLength(30);
    expect(second.more).toBe(false);
    expect(second.events[0]?.taskId).toBe("task-29");
    const ids = [...first.events, ...second.events].map((event) => event.id);
    expect(new Set(ids).size).toBe(130);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("orders cards written in the same millisecond by id", () => {
    const { events } = setup();
    fill(events, 3);
    expect(events.list("u1", AGENT).events.map((event) => event.taskId)).toEqual([
      "task-2",
      "task-1",
      "task-0",
    ]);
    const middle = events.list("u1", AGENT).events[1];
    expect(
      events.list("u1", AGENT, { at: middle?.at ?? 0, id: middle?.id ?? 0 }).events.map((e) => e.taskId),
    ).toEqual(["task-0"]);
  });

  it("reads nothing of another owner's agent or another agent's cards", () => {
    const { events } = setup();
    fill(events, 2);
    expect(events.list("u2", AGENT).events).toEqual([]);
    expect(events.list("u1", "other-0000").events).toEqual([]);
  });

  it("leaves out a row that no longer parses, says so with a count, and keeps the rest of the page", () => {
    const { bump } = setup();
    const warn = vi.fn();
    const events = createAgentEvents({
      db: bed.db,
      clock: bed.clock,
      logger: { warn } as never,
      unread: { bump },
    });
    fill(events, 2);
    bed.db.run("UPDATE agent_events SET data = '{\"nope\":1}' WHERE task_id = 'task-0'");
    expect(events.list("u1", AGENT).events.map((event) => event.taskId)).toEqual(["task-1"]);
    expect(warn).toHaveBeenCalledWith("agent_events_unreadable", { count: 1 });
  });

  it("carries the untrusted text as data, never changed", () => {
    const { events } = setup();
    events.isolated("u1", AGENT, "t", card({ summary: "<script>alert(1)</script> **bold**" }));
    expect(events.list("u1", AGENT).events[0]).toMatchObject({
      kind: "isolated",
      data: { summary: "<script>alert(1)</script> **bold**" },
    });
  });
});

describe("the rail's red dot (M11R62)", () => {
  it("is true while the newest card says failed and the thread has unread things; false once read or newer", () => {
    const { events } = setup();
    expect(events.failedCard("u1", AGENT)).toBe(false);
    events.runCard("u1", AGENT, "t1", "task", { title: "A", state: "running" });
    events.runCardEnded("u1", AGENT, "t1", { state: "failed" });
    bed.db.run("UPDATE agents SET unread = 1");
    expect(events.failedCard("u1", AGENT)).toBe(true);
    expect(events.failedCard("u2", AGENT)).toBe(false);
    bed.db.run("UPDATE agents SET unread = 0");
    expect(events.failedCard("u1", AGENT)).toBe(false);
    bed.db.run("UPDATE agents SET unread = 2");
    events.runCard("u1", AGENT, "t2", "task", { title: "B", state: "done" });
    expect(events.failedCard("u1", AGENT)).toBe(false);
  });
});

describe("fix round 1: the page's cursor and the guarded move", () => {
  it("gives the cursor of the last row read, and none for an empty list", () => {
    const { events } = setup();
    expect(events.list("u1", AGENT).next).toBeNull();
    for (let n = 0; n < 3; n += 1)
      events.runCard("u1", AGENT, `t${n}`, "task", { title: `T${n}`, state: "done" });
    const page = events.list("u1", AGENT);
    const last = page.events.at(-1);
    expect(page.next).toEqual({ at: last?.at, id: last?.id });
  });

  it("gives a cursor for a page whose rows are all unreadable, so the reader can go on", () => {
    const { events } = setup();
    for (let n = 0; n < 3; n += 1)
      events.runCard("u1", AGENT, `t${n}`, "task", { title: `T${n}`, state: "done" });
    bed.db.run("UPDATE agent_events SET data = '{}'");
    const page = events.list("u1", AGENT);
    expect(page.events).toEqual([]);
    const oldest = rows()[0];
    expect(page.next).toEqual({ at: oldest?.at, id: expect.any(Number) });
  });

  it("moves only a card that is still running when asked to (a boot-time settle never rewrites a final card)", () => {
    const { events, bump } = setup();
    events.runCard("u1", AGENT, "t1", "task", { title: "A", state: "running" });
    expect(events.runCardEnded("u1", AGENT, "t1", { state: "failed" }, { whileRunning: true })).toBe(true);
    bump.mockClear();
    expect(events.runCardEnded("u1", AGENT, "t1", { state: "done" }, { whileRunning: true })).toBe(false);
    expect(JSON.parse(rows()[0]?.data ?? "").state).toBe("failed");
    expect(bump).not.toHaveBeenCalled();
  });
});

describe("a card that is refused is logged", () => {
  it("says the kind and the agent, never the card's text", () => {
    bed = createAgentsBed();
    const warn = vi.fn();
    const events = createAgentEvents({
      db: bed.db,
      clock: bed.clock,
      logger: { warn },
      unread: { bump: vi.fn() },
    });
    expect(events.write("u1", AGENT, "isolated", "task-1", { summary: "secret-words" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("agent_event_refused", { kind: "isolated", agentId: AGENT });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-words");
  });
});
