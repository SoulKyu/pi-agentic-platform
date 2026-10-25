import { AgentInput, TriggerInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { journalOf, openOwner, type Owner, result, rows } from "./testing/automation-bed.ts";
import { createSteppableClock, PARKED_FROM_MS, type SteppableClock } from "./testing/steppable-clock.ts";

// M11R74 in a whole daemon: an agent with a daily budget runs a scheduled thread task that spends past it, the next
// scheduled fire is refused `budget`, the owner's own message in the thread still runs, and clearing the budget in the
// agent's configuration lets the next fire run at once. The scripted provider reports a price for every reply.

const FIVE_MINUTES = 5 * 60_000;
const STEPS = [
  { text: "Round one: all quiet." },
  { text: "Hello owner." },
  { text: "Round three: all quiet." },
];
const BUDGET = 0.01;

let t: TestDaemon;
let owner: Owner;
let clock: SteppableClock;
beforeAll(async () => {
  clock = createSteppableClock();
  // $1 000 per million tokens: any reply costs far more than the one cent the agent may spend in a day.
  t = await startTestDaemon(
    { prices: { input: 1000, output: 1000 }, steps: STEPS },
    { deps: { clock }, vm: true },
  );
  owner = await openOwner(t);
});
afterAll(async () => {
  owner.client.close();
  await t.stop();
});

const call = async <T>(method: string, params: object): Promise<T> =>
  result<T>(await owner.client.call(method as never, params as never));
const tasksOf = (agentId: string) =>
  rows<{ id: string; state: string; reason: string | null; target: string; origin: string }>(
    t.home,
    "SELECT id, state, reason, target, origin FROM tasks WHERE agent_id = ? ORDER BY created_at, id",
    agentId,
  );
const runsOf = (agentId: string) =>
  rows<{ origin: string; status: string; cost_usd: number; task_id: string | null; agent_id: string }>(
    t.home,
    "SELECT origin, status, cost_usd, task_id, agent_id FROM runs WHERE agent_id = ? ORDER BY started_at, id",
    agentId,
  );

describe("an agent's daily budget (M11R74, owner m14)", () => {
  it("refuses the next scheduled fire once a thread task spent past it, still takes the owner's message, and a cleared budget lets a fire run", async () => {
    // The schedule's wake-up must be a parked timer: `advance` cannot move a real one (see `alignTo`).
    // The test moves the clock about 20 minutes and compares a day's spend: start it a day away from a midnight crossing.
    const DAY = 86_400_000;
    if (DAY - (clock.now() % DAY) < 3_600_000) await clock.alignTo(DAY);
    await clock.alignTo(FIVE_MINUTES);
    await t.confirmStepUp(owner.cookie); // the jump let the step-up lapse
    const created = await call<{ id: string; revision: number }>("agents.create", {
      input: AgentInput.parse({
        name: "Atlas",
        preset: "chat",
        sandbox: { required: false },
        budget: { usdPerDay: BUDGET, tokensPerDay: null },
      }),
    });
    const agentId = created.id;
    const trigger = await call<{ trigger: { id: string } }>("automation.triggers.create", {
      input: TriggerInput.parse({
        name: "Round",
        enabled: true,
        source: { type: "schedule", rrule: "FREQ=MINUTELY;INTERVAL=5", timezone: "UTC", catchUp: "once" },
        execution: { agent: { agentId, target: "thread" } },
        prompt: "Take the round.",
      }),
    });
    const triggerId = trigger.trigger.id;
    const [armed] = rows<{ next_fire_at: number }>(
      t.home,
      "SELECT next_fire_at FROM triggers WHERE id = ?",
      triggerId,
    );
    expect((armed?.next_fire_at ?? 0) - clock.now()).toBeGreaterThanOrEqual(PARKED_FROM_MS);

    // 1. The first scheduled fire runs in the agent's thread; its first reply spends past the budget, and the run is cut
    // short across the run (limits): the task fails with `budget`, the thread stays.
    await clock.advance(FIVE_MINUTES);
    await vi.waitFor(() => expect(tasksOf(agentId).map((task) => task.state)).toEqual(["failed"]), {
      timeout: 60_000,
    });
    expect(tasksOf(agentId)[0]).toMatchObject({ target: "thread", origin: "schedule", reason: "budget" });
    await vi.waitFor(() => expect(runsOf(agentId)[0]?.status).not.toBe("running"), { timeout: 30_000 });
    expect(runsOf(agentId)[0]?.cost_usd).toBeGreaterThanOrEqual(BUDGET);
    expect(runsOf(agentId)[0]).toMatchObject({ origin: "schedule", agent_id: agentId });

    // 2. The next scheduled fire is refused: budget, journaled, no task.
    await clock.advance(FIVE_MINUTES);
    await vi.waitFor(
      async () =>
        expect((await journalOf(owner.client, triggerId)).map((entry) => entry.verdict)).toContain("budget"),
      { timeout: 30_000 },
    );
    expect(tasksOf(agentId)).toHaveLength(1);

    // 3. The owner's own message in the thread is counted, never gated: it runs.
    const opened = await call<{ sessionId: string }>("agents.openThread", { agentId });
    const sent = await call<{ disposition: string }>("sessions.prompt", {
      sessionId: opened.sessionId,
      text: "Hello Atlas.",
    });
    expect(sent.disposition).toBe("started");
    await vi.waitFor(
      () => {
        const runs = runsOf(agentId);
        expect(runs).toHaveLength(2);
        expect(runs[1]).toMatchObject({ origin: "user", status: "completed", task_id: null });
      },
      { timeout: 60_000 },
    );
    expect(tasksOf(agentId)).toHaveLength(1);

    // 4. The owner clears the budget in the agent's configuration: the next fire runs, no restart.
    const view = await call<{ revision: number }>("agents.get", { agentId });
    await call("agents.update", {
      agentId,
      baseRevision: view.revision,
      input: AgentInput.parse({
        name: "Atlas",
        preset: "chat",
        sandbox: { required: false },
        budget: { usdPerDay: null, tokensPerDay: null },
      }),
    });
    await clock.advance(FIVE_MINUTES);
    await vi.waitFor(() => expect(tasksOf(agentId).map((task) => task.state)).toEqual(["failed", "done"]), {
      timeout: 60_000,
    });
    expect(tasksOf(agentId)[1]).toMatchObject({ target: "thread", origin: "schedule" });

    // 5. The thread outlived both tasks, each of them left its card, and the status reads what the runs table says.
    const [thread] = rows<{ archived_at: number | null }>(
      t.home,
      "SELECT archived_at FROM sessions WHERE id = ?",
      opened.sessionId,
    );
    expect(thread?.archived_at).toBeNull();
    const cards = await call<{ events: Array<{ kind: string; data: { state: string } }> }>("agents.events", {
      agentId,
    });
    expect(cards.events.map((event) => [event.kind, event.data.state])).toEqual([
      ["schedule", "done"],
      ["schedule", "failed"],
    ]);
    const status = await call<{ today: { usd: number; budgetUsd: number | null }; tasks: unknown[] }>(
      "agents.status",
      { agentId },
    );
    const spent = rows<{ usd: number }>(
      t.home,
      "SELECT SUM(cost_usd) AS usd FROM runs WHERE agent_id = ?",
      agentId,
    )[0]?.usd;
    expect(status.today.usd).toBeCloseTo(spent ?? -1, 10);
    expect(status.today.budgetUsd).toBeNull();
    expect(status.tasks).toHaveLength(2);
  }, 180_000);
});
