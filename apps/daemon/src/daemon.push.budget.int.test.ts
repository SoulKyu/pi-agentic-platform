import { AgentInput, NotificationsSettings, PushWire, TriggerInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeTransport, type FakeTransport } from "./modules/push/testing/fake-transport.ts";
import {
  createMemorySubscriptions,
  type MemorySubscriptions,
} from "./modules/push/testing/memory-subscriptions.ts";
import { openOwner, type Owner, result, rows, setAutomation } from "./security/testing/automation-bed.ts";
import { createSteppableClock, type SteppableClock } from "./security/testing/steppable-clock.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

// M12 task 12 through a whole daemon: a scheduled thread task of an agent spends past both the owner-wide and the
// agent's daily budget. Each scope pushes once; the next run of the day pushes nothing (budget-once-per-day). The test
// moves the clock to noon UTC first (the day key is a zone day), and the owner chose `titles: "names"` (M12R7).

const FIVE_MINUTES = 5 * 60_000;
const LIMIT = 0.01;
const DAY = 24 * 3_600_000;
const NOON = 12 * 3_600_000;

let t: TestDaemon;
let owner: Owner;
let clock: SteppableClock;
let transport: FakeTransport;
let subs: MemorySubscriptions;
beforeAll(async () => {
  clock = createSteppableClock();
  transport = createFakeTransport();
  subs = createMemorySubscriptions();
  // $1 000 per million tokens: any reply costs far more than a cent.
  t = await startTestDaemon(
    { prices: { input: 1000, output: 1000 }, steps: [{ text: "Round one." }, { text: "Hello owner." }] },
    { deps: { clock, push: { transport, subscriptions: subs, sessionLive: subs } }, vm: true },
  );
  owner = await openOwner(t);
  const [user] = rows<{ id: string }>(t.home, "SELECT id FROM users");
  subs.add(user?.id ?? "", {
    id: "phone",
    endpoint: "https://push.example.net/phone",
    p256dh: "p",
    auth: "a",
    credentialId: "c-phone",
    locale: "en",
  });
}, 60_000);
afterAll(async () => {
  owner.client.close();
  await t.stop();
});

const call = async <T>(method: string, params: object): Promise<T> =>
  result<T>(await owner.client.call(method as never, params as never));
const budgetEvents = () =>
  rows<{ id: string; ref_id: string; state: string }>(
    t.home,
    "SELECT id, ref_id, state FROM push_events WHERE cls = 'budget' ORDER BY ref_id",
  );
/** The wire of every send of the class; the failed task of the same run also pushes (its own class). */
const budgetWires = () =>
  transport.sent
    .map((sent) => ({ text: new TextDecoder().decode(sent.plaintext) }))
    .map(({ text }) => ({ text, wire: PushWire.parse(JSON.parse(text)) }))
    .filter(({ wire }) => wire.cls === "budget");
const runsDone = (agentId: string) =>
  rows<{ status: string }>(t.home, "SELECT status FROM runs WHERE agent_id = ? ORDER BY started_at", agentId);

describe("budget-once-per-day", () => {
  it("the owner-wide and the per-agent budget each push once, and the next run of the day pushes nothing", async () => {
    // The budget day is a zone day: start at noon UTC, so no run of this test can straddle midnight whatever the wall clock says.
    await clock.advance((NOON - (clock.now() % DAY) + DAY) % DAY);
    await t.confirmStepUp(owner.cookie); // the jump let the step-up lapse
    await setAutomation(owner.client, { dailyBudgetUsd: LIMIT, timezone: "UTC" });
    const current = await call<{ revision: number }>("settings.get", { key: "notifications" });
    await call("settings.set", {
      key: "notifications",
      value: NotificationsSettings.parse({ titles: "names" }),
      baseRevision: current.revision,
    });
    const created = await call<{ id: string }>("agents.create", {
      input: AgentInput.parse({
        name: "Atlas",
        preset: "chat",
        sandbox: { required: false },
        budget: { usdPerDay: LIMIT, tokensPerDay: null },
      }),
    });
    const agentId = created.id;
    await call("automation.triggers.create", {
      input: TriggerInput.parse({
        name: "Round",
        enabled: true,
        source: { type: "schedule", rrule: "FREQ=MINUTELY;INTERVAL=5", timezone: "UTC", catchUp: "once" },
        execution: { agent: { agentId, target: "thread" } },
        prompt: "Take the round.",
      }),
    });

    // 1. The first fire spends past both limits: two events, two sends, no amount and no name on the wire.
    await clock.advance(FIVE_MINUTES);
    await vi.waitFor(
      () => {
        expect(budgetEvents()).toHaveLength(2);
        expect(budgetEvents().map((event) => event.state)).toEqual(["sent", "sent"]);
      },
      { timeout: 60_000 },
    );
    const scopes = budgetEvents().map((event) => event.ref_id.replace(/:\d{4}-\d{2}-\d{2}$/, ""));
    expect(scopes.filter((scope) => scope === "owner")).toHaveLength(1);
    expect(scopes.filter((scope) => scope === `agent:${agentId}`)).toHaveLength(1);
    expect(budgetWires()).toHaveLength(2);
    // titles: "names" adds the agent's registry name to its own push only; no amount is ever on the wire.
    expect(
      budgetWires()
        .map(({ wire }) => wire.body)
        .sort(),
    ).toEqual(["A budget is reached.", "A budget is reached. - Atlas"]);
    for (const { text, wire } of budgetWires()) {
      expect(wire).toMatchObject({ cls: "budget", title: "pap" });
      expect(text).not.toMatch(/\d\.\d\d/);
    }

    // 2. push.open lands on the right screen for each.
    for (const { wire } of budgetWires()) {
      const { id } = wire;
      const target = (await call<{ target: { kind: string; id: string | null } }>("push.open", { id }))
        .target;
      expect([`settings`, `agent`]).toContain(target.kind);
      expect(target.id).toBe(target.kind === "agent" ? agentId : "automation");
    }

    // 3. The next scheduled fire is refused by the gate; the owner's own message runs: neither pushes again.
    await clock.advance(FIVE_MINUTES);
    const opened = await call<{ sessionId: string }>("agents.openThread", { agentId });
    const sent = await call<{ disposition: string }>("sessions.prompt", {
      sessionId: opened.sessionId,
      text: "Hello Atlas.",
    });
    expect(sent.disposition).toBe("started");
    await vi.waitFor(
      () => {
        const runs = runsDone(agentId);
        expect(runs).toHaveLength(2);
        expect(runs[1]?.status).not.toBe("running");
      },
      { timeout: 60_000 },
    );
    await clock.advance(1_000);
    expect(budgetEvents()).toHaveLength(2);
    expect(budgetWires()).toHaveLength(2);
  }, 180_000);
});
