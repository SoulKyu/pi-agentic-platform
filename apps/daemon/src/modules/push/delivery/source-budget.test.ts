import { NotificationsSettings, PushWire, type AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEndEvent } from "../../runs/index.ts";
import { OWNER, openSendBed, type SendBed } from "../testing/send-bed.ts";
import { wireBudgetSource } from "./source-budget.ts";

let t: SendBed;
let stop: () => void = () => {};
afterEach(() => {
  stop();
  t.close();
});

const DAY_ONE = 1_700_000_000_000; // 2023-11-14T22:13Z
const HOUR = 3_600_000;

interface AgentFixture {
  name: string;
  budget: { usdPerDay: number | null; tokensPerDay: number | null } | null;
  usd: number;
  tokens: number;
}

/** The ports the source reads, with the spend in the test's hands. */
function rig(options: { timezone?: string | null; dailyBudgetUsd?: number | null } = {}) {
  t = openSendBed(["a"]);
  const state = {
    ownerSpent: 0,
    owner: OWNER as string | null,
    settings: {
      dailyBudgetUsd: options.dailyBudgetUsd === undefined ? 5 : options.dailyBudgetUsd,
      timezone: options.timezone === undefined ? "UTC" : options.timezone,
    } as Pick<AutomationSettings, "dailyBudgetUsd" | "timezone">,
    agents: new Map<string, AgentFixture>(),
    sessions: new Map<string, string>(),
  };
  const listeners = new Set<(event: RunEndEvent) => void>();
  const notified: Array<Record<string, unknown>> = [];
  const source = wireBudgetSource({
    db: t.bed.db,
    clock: t.bed.clock,
    logger: t.bed.logger,
    notifier: {
      ...t.notifier,
      notify: (event) => {
        notified.push(event);
        return t.notifier.notify(event);
      },
    },
    runs: {
      onRunEnd: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      spentToday: () => state.ownerSpent,
    },
    spend: {
      agentSpentToday: (_owner, agentId) => ({
        usd: state.agents.get(agentId)?.usd ?? 0,
        tokens: state.agents.get(agentId)?.tokens ?? 0,
      }),
      agentsRunToday: () => [...state.agents.keys()],
    },
    settings: () => state.settings,
    agents: {
      get: (_owner, agentId) => {
        const agent = state.agents.get(agentId);
        return agent === undefined
          ? null
          : { name: agent.name, input: agent.budget === null ? null : { budget: agent.budget } };
      },
    },
    kindOf: (sessionId) =>
      state.sessions.has(sessionId) ? { agentId: state.sessions.get(sessionId) ?? null } : null,
    ownerId: () => state.owner,
  });
  stop = source.stop;
  const end = (sessionId = "s1"): void => {
    for (const listener of [...listeners])
      listener({
        runId: "r",
        sessionId,
        ownerId: OWNER,
        taskId: null,
        origin: "user",
        status: "completed",
        costUsd: 0,
        errorClass: null,
        limitResetAt: null,
      });
  };
  const agent = (id: string, patch: Partial<AgentFixture> = {}, sessionId?: string): void => {
    state.agents.set(id, {
      name: id.toUpperCase(),
      budget: { usdPerDay: 1, tokensPerDay: null },
      usd: 0,
      tokens: 0,
      ...patch,
    });
    state.sessions.set(sessionId ?? `s-${id}`, id);
  };
  return { state, source, end, agent, notified };
}

const events = () =>
  t.bed.db.all<{ cls: string; ref_kind: string; ref_id: string; name: string | null; state: string }>(
    "SELECT cls, ref_kind, ref_id, name, state FROM push_events ORDER BY created_at, rowid",
  );
const refs = () => events().map((row) => row.ref_id);

describe("the owner-wide daily budget (M12R25, M12R26)", () => {
  it("a run end that reaches the limit pushes once; the next run end the same day pushes nothing", () => {
    const { state, end } = rig();
    state.ownerSpent = 4.99;
    end();
    expect(events()).toEqual([]);
    state.ownerSpent = 5;
    end();
    expect(events()).toEqual([
      { cls: "budget", ref_kind: "budget", ref_id: "owner:2023-11-14", name: null, state: "pending" },
    ]);
    state.ownerSpent = 7;
    end();
    expect(events()).toHaveLength(1);
  });

  it("once-per-day holds after the event settled: any state counts", async () => {
    const { state, end } = rig();
    state.ownerSpent = 9;
    end();
    await t.step();
    expect(events().map((row) => row.state)).toEqual(["sent"]);
    end();
    await t.step();
    expect(events()).toHaveLength(1);
  });

  it("a new zone day pushes again", async () => {
    const { state, end } = rig({ timezone: "UTC" });
    state.ownerSpent = 9;
    end();
    await t.step();
    await t.step(3 * HOUR); // 2023-11-15T01:13Z
    end();
    expect(refs()).toEqual(["owner:2023-11-14", "owner:2023-11-15"]);
  });

  it("the day is the owner's zone day, not UTC", async () => {
    const { state, end } = rig({ timezone: "Asia/Tokyo" }); // 2023-11-15 07:13 there
    state.ownerSpent = 9;
    end();
    expect(refs()).toEqual(["owner:2023-11-15"]);
    await t.step(HOUR); // still the 15th in Tokyo
    end();
    expect(refs()).toEqual(["owner:2023-11-15"]);
  });

  it("a 25 h day (the clock goes back) stays one event", async () => {
    const { state, end } = rig({ timezone: "Europe/Paris" });
    // 2026-10-24T22:30Z is 00:30 on Sunday 25 October in Paris, the day the clock goes back.
    await t.step(Date.UTC(2026, 9, 24, 22, 30) - DAY_ONE);
    state.ownerSpent = 9;
    end();
    // 2026-10-25T22:30Z is 23:30 the same Paris day (25 h long).
    await t.step(24 * HOUR);
    end();
    expect(refs()).toEqual(["owner:2026-10-25"]);
    await t.step(HOUR); // 23:30Z is 00:30 on the 26th
    end();
    expect(refs()).toEqual(["owner:2026-10-25", "owner:2026-10-26"]);
  });

  it("a null timezone uses the server's own zone without failing", () => {
    const { state, end } = rig({ timezone: null });
    state.ownerSpent = 9;
    end();
    expect(events()).toHaveLength(1);
  });

  it("no budget set pushes nothing; a budget of 0 pushes nothing (M12R26)", () => {
    const none = rig({ dailyBudgetUsd: null });
    none.state.ownerSpent = 100;
    none.end();
    expect(events()).toEqual([]);
    none.state.settings = { ...none.state.settings, dailyBudgetUsd: 0 };
    none.end();
    expect(events()).toEqual([]);
  });

  it("the wire carries no amount and no name: A budget is reached.", async () => {
    const { state, end } = rig();
    state.ownerSpent = 123.456;
    end();
    await t.step();
    const text = new TextDecoder().decode(t.transport.sent[0]?.plaintext);
    expect(PushWire.parse(JSON.parse(text))).toMatchObject({
      cls: "budget",
      title: "pap",
      body: "A budget is reached.",
    });
    expect(text).not.toMatch(/\d\.\d|123/);
  });
});

describe("the once-per-day check belongs to its owner (final review, minor 9)", () => {
  it("another owner's event of the same scope and day does not silence this owner", () => {
    const { state, end } = rig();
    t.bed.db.run(
      `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
       VALUES ('other', 'u2', 'budget', 'budget', 'owner:2023-11-14', 'push:budget:budget:owner:2023-11-14', 'sent', 1)`,
    );
    state.ownerSpent = 5;
    end();
    expect(events().filter((row) => row.state === "pending")).toHaveLength(1);
  });
});

describe("titles: names on a budget push (M12R7)", () => {
  const body = (index: number) =>
    PushWire.parse(JSON.parse(new TextDecoder().decode(t.transport.sent[index]?.plaintext))).body;

  it("an agent's budget carries the registry name and no amount; the owner-wide budget has no name to carry", async () => {
    const { state, end, agent } = rig();
    t.state.settings = NotificationsSettings.parse({ titles: "names" });
    state.ownerSpent = 123.456;
    agent("a", { name: "Atlas", usd: 7.89 });
    end("s-a");
    await t.step();
    expect(t.transport.sent).toHaveLength(2);
    expect([body(0), body(1)].sort()).toEqual(["A budget is reached.", "A budget is reached. - Atlas"]);
    const text = t.transport.sent.map((sent) => new TextDecoder().decode(sent.plaintext)).join(" ");
    expect(text).not.toMatch(/\d\.\d|123|7\.89/);
  });

  it("the generic default carries no name at all", async () => {
    const { end, agent } = rig();
    agent("a", { name: "Atlas", usd: 7.89 });
    end("s-a");
    await t.step();
    expect(body(0)).toBe("A budget is reached.");
  });
});

describe("a per-agent budget", () => {
  it("agent A reaching its own limit pushes with the agent's name; agent B is unaffected", () => {
    const { end, agent } = rig();
    agent("a", { usd: 1 });
    agent("b", { usd: 0.5 });
    end("s-a");
    end("s-b");
    expect(events()).toEqual([
      { cls: "budget", ref_kind: "budget", ref_id: "agent:a:2023-11-14", name: "A", state: "pending" },
    ]);
  });

  it("a second run of the same agent the same day pushes nothing", () => {
    const { end, agent } = rig();
    agent("a", { usd: 2 });
    end("s-a");
    end("s-a");
    expect(events()).toHaveLength(1);
  });

  it("one run that reaches both lines pushes two events", () => {
    const { state, end, agent } = rig();
    state.ownerSpent = 5;
    agent("a", { usd: 1 });
    end("s-a");
    expect(refs().sort()).toEqual(["agent:a:2023-11-14", "owner:2023-11-14"]);
  });

  it("the token budget counts", () => {
    const { end, agent } = rig();
    agent("a", { budget: { usdPerDay: null, tokensPerDay: 1000 }, tokens: 999 });
    end("s-a");
    expect(events()).toEqual([]);
    agent("a", { budget: { usdPerDay: null, tokensPerDay: 1000 }, tokens: 1000 });
    end("s-a");
    expect(refs()).toEqual(["agent:a:2023-11-14"]);
  });

  it.each([
    ["no budget", null],
    ["no limits", { usdPerDay: null, tokensPerDay: null }],
    ["a budget of 0", { usdPerDay: 0, tokensPerDay: 0 }],
  ])("%s pushes nothing", (_name, budget) => {
    const { end, agent } = rig();
    agent("a", { budget, usd: 50, tokens: 50 });
    end("s-a");
    expect(events()).toEqual([]);
  });

  it("a session that belongs to no agent, or an unknown session, only checks the owner-wide line", () => {
    const { end, state, agent } = rig();
    // An agent is over its own budget, so a check that wrongly reached for it would push; neither session is its own.
    agent("a", { usd: 50 });
    state.sessions.set("plain", "");
    state.ownerSpent = 5;
    end("plain");
    end("unknown");
    expect(refs()).toEqual(["owner:2023-11-14"]);
  });

  it("the next zone day pushes again", async () => {
    const { end, agent } = rig();
    agent("a", { usd: 2 });
    end("s-a");
    await t.step(3 * HOUR);
    end("s-a");
    expect(refs()).toEqual(["agent:a:2023-11-14", "agent:a:2023-11-15"]);
  });
});

describe("restart and boot (M12R26)", () => {
  it("the day's event in the table stops a second push after a reboot: the dedupe reads the table, not memory", async () => {
    const first = rig();
    first.state.ownerSpent = 9;
    first.end();
    await t.step(); // the push is sent and settled: only the table remembers it
    expect(events().map((row) => row.state)).toEqual(["sent"]);
    first.source.stop();
    // A second source on the same database, nothing in its memory.
    const listeners = new Set<(event: RunEndEvent) => void>();
    const again = wireBudgetSource({
      db: t.bed.db,
      clock: t.bed.clock,
      logger: t.bed.logger,
      notifier: t.notifier,
      runs: {
        onRunEnd: (listener) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        spentToday: () => 9,
      },
      spend: { agentSpentToday: () => ({ usd: 0, tokens: 0 }), agentsRunToday: () => [] },
      settings: () => first.state.settings,
      agents: { get: () => null },
      kindOf: () => null,
      ownerId: () => OWNER,
    });
    again.boot();
    expect(events()).toHaveLength(1);
    again.stop();
  });

  it("boot pushes a budget already reached today, owner-wide and per agent", () => {
    const { state, source, agent } = rig();
    state.ownerSpent = 6;
    agent("a", { usd: 3 });
    agent("b", { usd: 0.1 });
    source.boot();
    expect(refs().sort()).toEqual(["agent:a:2023-11-14", "owner:2023-11-14"]);
  });

  it("boot with no owner yet, or a failing lookup, pushes nothing and does not throw", () => {
    const { state, source } = rig();
    state.owner = null;
    expect(() => source.boot()).not.toThrow();
    state.owner = OWNER;
    state.settings = new Proxy(state.settings, {
      get() {
        throw new Error("settings down");
      },
    });
    expect(() => source.boot()).not.toThrow();
    expect(events()).toEqual([]);
  });
});
