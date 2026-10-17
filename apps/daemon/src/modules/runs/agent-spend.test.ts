import { afterEach, describe, expect, it } from "vitest";
import { createAgentSpend } from "./agent-spend.ts";
import { createRunsModule, type RunsService } from "./index.ts";
import { assistantEnd } from "./testing/events.ts";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";

let bed: RunsBed;
afterEach(() => bed.close());

const ATLAS = "atlas-1a2b";
const OTHER = "birch-3c4d";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(): { service: RunsService; spend: ReturnType<typeof createAgentSpend> } {
  bed = openRunsBed();
  const service = createRunsModule({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    appendLine: () => {},
  });
  return { service, spend: createAgentSpend({ db: bed.db, clock: bed.clock }) };
}

interface Who {
  readonly id: string;
  readonly ownerId: string;
  readonly agentId?: string;
  readonly parentSessionId?: string;
}

/** One run of `session`: opened, charged, and closed unless `live`. */
function run(
  service: RunsService,
  session: Who,
  usage: { cost?: number; input?: number; output?: number },
  how: { live?: boolean; taskId?: string | null } = {},
): void {
  if (how.taskId) service.port.expectOrigin(session.id, { origin: "schedule", taskId: how.taskId });
  service.observer.onRecord(session, "run_start", { origin: "user" }, null);
  service.observer.onEvent(session.id, assistantEnd(usage));
  if (how.live !== true) service.observer.onRecord(session, "run_end", { aborted: false }, null);
}

const rows = () =>
  bed.db.all<{ session_id: string; agent_id: string | null; parent_session_id: string | null }>(
    "SELECT session_id, agent_id, parent_session_id FROM runs ORDER BY session_id",
  );

describe("the run's agent (M11R73)", () => {
  it("copies the agent and the parent from the session row when the run starts", () => {
    const { service } = setup();
    run(service, { id: "thread", ownerId: "u1", agentId: ATLAS }, { cost: 0.1 });
    run(service, { id: "child", ownerId: "u1", agentId: ATLAS, parentSessionId: "thread" }, { cost: 0.1 });
    run(service, { id: "plain", ownerId: "u1" }, { cost: 0.1 });
    expect(rows()).toEqual([
      { session_id: "child", agent_id: ATLAS, parent_session_id: "thread" },
      { session_id: "plain", agent_id: null, parent_session_id: null },
      { session_id: "thread", agent_id: ATLAS, parent_session_id: null },
    ]);
  });
});

describe("agentSpentToday (M11R74)", () => {
  it("adds the runs of the agent's thread, its tasks and its children, and no other agent's", () => {
    const { service, spend } = setup();
    run(service, { id: "thread", ownerId: "u1", agentId: ATLAS }, { cost: 0.1, input: 10, output: 5 });
    run(service, { id: "task", ownerId: "u1", agentId: ATLAS }, { cost: 0.2, input: 20 }, { taskId: "t1" });
    run(
      service,
      { id: "kid", ownerId: "u1", agentId: ATLAS, parentSessionId: "thread" },
      { cost: 0.3, output: 7 },
    );
    run(service, { id: "birch", ownerId: "u1", agentId: OTHER }, { cost: 5, input: 999 });
    run(service, { id: "plain", ownerId: "u1" }, { cost: 7, input: 999 });
    const today = spend.agentSpentToday("u1", ATLAS, "UTC");
    expect(today.usd).toBeCloseTo(0.6, 10);
    expect(today.tokens).toBe(42);
    expect(spend.agentSpentToday("u1", OTHER, "UTC")).toEqual({ usd: 5, tokens: 999 });
    expect(spend.agentSpentToday("u1", "nobody-0000", "UTC")).toEqual({ usd: 0, tokens: 0 });
  });

  it("never reads another owner's runs", () => {
    const { service, spend } = setup();
    run(service, { id: "s", ownerId: "u2", agentId: ATLAS }, { cost: 3, input: 3 });
    expect(spend.agentSpentToday("u1", ATLAS, "UTC")).toEqual({ usd: 0, tokens: 0 });
  });

  it("counts a run by the day it ended: one that ends after midnight counts the new day, not the old one", async () => {
    const { service, spend } = setup();
    await bed.clock.advance(11 * HOUR + 50 * 60_000); // 23:50 UTC on the 14th
    const session = { id: "night", ownerId: "u1", agentId: ATLAS };
    service.observer.onRecord(session, "run_start", { origin: "user" }, null);
    service.observer.onEvent(session.id, assistantEnd({ cost: 0.4, input: 4 }));
    expect(spend.agentSpentToday("u1", ATLAS, "UTC")).toEqual({ usd: 0.4, tokens: 4 });
    await bed.clock.advance(20 * 60_000); // 00:10 on the 15th
    service.observer.onRecord(session, "run_end", { aborted: false }, null);
    expect(spend.agentSpentToday("u1", ATLAS, "UTC")).toEqual({ usd: 0.4, tokens: 4 });
    await bed.clock.advance(DAY);
    expect(spend.agentSpentToday("u1", ATLAS, "UTC")).toEqual({ usd: 0, tokens: 0 });
  });

  it("counts the live cost and tokens of a run that has not ended", () => {
    const { service, spend } = setup();
    run(service, { id: "a", ownerId: "u1", agentId: ATLAS }, { cost: 0.25, input: 10 }, { live: true });
    expect(spend.agentSpentToday("u1", ATLAS, "UTC")).toEqual({ usd: 0.25, tokens: 10 });
  });

  it("uses the day of the owner's zone", async () => {
    const { service, spend } = setup();
    await bed.clock.advance(11 * HOUR + 30 * 60_000); // 23:30 UTC on the 14th
    run(service, { id: "a", ownerId: "u1", agentId: ATLAS }, { cost: 1, input: 1 });
    await bed.clock.advance(90 * 60_000); // 01:00 UTC on the 15th
    // 01:00 UTC is 03:00 in Paris on the 15th, and 23:30 UTC was 01:30 on the 15th there: both the same Paris day.
    expect(spend.agentSpentToday("u1", ATLAS, "Europe/Paris").usd).toBe(1);
    expect(spend.agentSpentToday("u1", ATLAS, "UTC").usd).toBe(0);
  });
});

describe("the longer windows and the billing label (M11R76)", () => {
  it("adds 7 and 30 days, today included, and nothing older", () => {
    const { service, spend } = setup();
    for (const daysAgo of [0, 3, 10, 40]) {
      run(service, { id: `s${daysAgo}`, ownerId: "u1", agentId: ATLAS }, { cost: 1 });
      bed.db.run(
        "UPDATE runs SET started_at = started_at - $by, ended_at = ended_at - $by WHERE session_id = $id",
        { by: daysAgo * DAY, id: `s${daysAgo}` },
      );
    }
    expect(spend.agentUsd("u1", ATLAS, "UTC", "7d")).toBe(2);
    expect(spend.agentUsd("u1", ATLAS, "UTC", "30d")).toBe(3);
  });

  it("reads the billing of the agent's runs: subscription wins, then api, else unknown", () => {
    const { service, spend } = setup();
    expect(spend.agentBilling("u1", ATLAS)).toBe("unknown");
    run(service, { id: "a", ownerId: "u1", agentId: ATLAS }, { cost: 1 });
    expect(spend.agentBilling("u1", ATLAS)).toBe("unknown");
    bed.db.run("UPDATE runs SET billing = 'api'");
    expect(spend.agentBilling("u1", ATLAS)).toBe("api");
    run(service, { id: "b", ownerId: "u1", agentId: ATLAS }, { cost: 1 });
    bed.db.run("UPDATE runs SET billing = 'subscription' WHERE session_id = 'b'");
    expect(spend.agentBilling("u1", ATLAS)).toBe("subscription");
  });
});

describe("the live hook (M11R74)", () => {
  it("sees the message it is told of: the row is saved before the hook, so a budget reads the new total", () => {
    const { service, spend } = setup();
    const seen: Array<{ usd: number; tokens: number }> = [];
    service.port.onLiveCost((_session, ownerId) => seen.push(spend.agentSpentToday(ownerId, ATLAS, "UTC")));
    run(service, { id: "a", ownerId: "u1", agentId: ATLAS }, { cost: 0.5, input: 7 }, { live: true });
    service.observer.onEvent("a", assistantEnd({ cost: 0.25, output: 3 }));
    expect(seen).toEqual([
      { usd: 0.5, tokens: 7 },
      { usd: 0.75, tokens: 10 },
    ]);
  });
});

describe("what one task's runs cost (a thread task shares its session)", () => {
  it("adds the runs of that task and no other, with how they were billed", () => {
    const { service, spend } = setup();
    run(service, { id: "thread", ownerId: "u1", agentId: ATLAS }, { cost: 0.4 }, { taskId: "t1" });
    run(service, { id: "thread", ownerId: "u1", agentId: ATLAS }, { cost: 0.1 }, { taskId: "t2" });
    run(service, { id: "thread", ownerId: "u1", agentId: ATLAS }, { cost: 9 });
    bed.db.run("UPDATE runs SET billing = 'subscription' WHERE task_id = 't1'");
    expect(spend.taskRuns("t1")).toEqual({ usd: 0.4, billing: "subscription" });
    expect(spend.taskRuns("t2")).toEqual({ usd: 0.1, billing: "unknown" });
    expect(spend.taskRuns("nobody")).toEqual({ usd: 0, billing: "unknown" });
  });
});

describe("agentsRunToday (M12R26: the boot check of the budget push)", () => {
  it("lists the owner's agents with a run today, open ones included, and not yesterday's, another owner's or none", async () => {
    const { service, spend } = setup();
    run(service, { id: "old", ownerId: "u1", agentId: OTHER }, { cost: 1 });
    await bed.clock.advance(2 * DAY);
    run(service, { id: "thread", ownerId: "u1", agentId: ATLAS }, { cost: 0.1 });
    run(service, { id: "live", ownerId: "u1", agentId: "cedar-5e6f" }, { cost: 0.1 }, { live: true });
    run(service, { id: "plain", ownerId: "u1" }, { cost: 0.1 });
    run(service, { id: "theirs", ownerId: "u2", agentId: "dune-7a8b" }, { cost: 0.1 });
    expect(spend.agentsRunToday("u1", "UTC")).toEqual([ATLAS, "cedar-5e6f"]);
  });
});
