import type { Caller, TaskView } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { createAgentSpend, RUNS_MIGRATIONS } from "../runs/index.ts";
import { createAgentEvents } from "./events.ts";
import type { AgentLinks } from "./links.ts";
import { createAgentReads } from "./status.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const DAY = 86_400_000;

async function setup(input: object = {}, links: AgentLinks = {}) {
  bed = createAgentsBed({ migrations: [RUNS_MIGRATIONS] });
  const { id } = await bed.agents.create(bed.owner(), agentInput(input));
  const spend = createAgentSpend({ db: bed.db, clock: bed.clock });
  const events = createAgentEvents({
    db: bed.db,
    clock: bed.clock,
    logger: { warn: vi.fn() } as never,
    unread: { bump: vi.fn() },
  });
  const reads = createAgentReads({
    store: bed.agents.store,
    events,
    spend,
    timeZone: () => "UTC",
    links: () => links,
  });
  return { id, reads, events, caller: testCaller() as Caller };
}

function run(
  agentId: string | null,
  how: {
    usd?: number;
    tokens?: number;
    daysAgo?: number;
    billing?: string;
    status?: string;
    owner?: string;
  } = {},
): void {
  const at = bed.clock.now() - (how.daysAgo ?? 0) * DAY;
  const open = how.status === "running";
  bed.db.run(
    `INSERT INTO runs (id, owner_id, session_id, origin, status, started_at, ended_at, input_tokens, output_tokens,
       cost_usd, billing, agent_id)
     VALUES ($id, $owner, 's', 'user', $status, $at, $ended, $in, $out, $usd, $billing, $agent)`,
    {
      id: `r-${Math.random().toString(16).slice(2)}`,
      owner: how.owner ?? "u1",
      status: how.status ?? "completed",
      at,
      ended: open ? null : at,
      in: how.tokens ?? 0,
      out: 0,
      usd: how.usd ?? 0,
      billing: how.billing ?? "unknown",
      agent: agentId,
    },
  );
}

describe("agents.status (M11R76)", () => {
  it("equals the runs rows: today, the last 7 days and the last 30", async () => {
    const { id, reads, caller } = await setup({ budget: { usdPerDay: 5, tokensPerDay: 2000 } });
    run(id, { usd: 0.5, tokens: 100 });
    run(id, { usd: 0.25, tokens: 50, status: "running" });
    run(id, { usd: 1, tokens: 10, daysAgo: 3 });
    run(id, { usd: 2, tokens: 10, daysAgo: 20 });
    run(id, { usd: 4, tokens: 10, daysAgo: 45 });
    run(null, { usd: 99, tokens: 99 });
    run(id, { usd: 99, tokens: 99, owner: "u2" });
    const status = reads.status(caller, id);
    expect(status.today).toEqual({ usd: 0.75, tokens: 150, budgetUsd: 5, budgetTokens: 2000 });
    expect(status.days7Usd).toBeCloseTo(1.75, 10);
    expect(status.days30Usd).toBeCloseTo(3.75, 10);
    const sql = bed.db.get<{ usd: number }>(
      "SELECT SUM(cost_usd) AS usd FROM runs WHERE agent_id = $id AND owner_id = 'u1' AND started_at >= $from",
      { id, from: bed.clock.now() - 30 * DAY },
    );
    expect(sql?.usd).toBeCloseTo(status.days30Usd, 10);
  });

  it("says no budget as nulls, and zeros for an agent that has run nothing", async () => {
    const { id, reads, caller } = await setup();
    expect(reads.status(caller, id)).toEqual({
      today: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
      days7Usd: 0,
      days30Usd: 0,
      billing: "unknown",
      tasks: [],
      triggers: [],
      truncated: false,
    });
  });

  it("labels the billing: a subscription's figures are API-equivalent", async () => {
    const { id, reads, caller } = await setup();
    run(id, { usd: 1, billing: "api" });
    expect(reads.status(caller, id).billing).toBe("api");
    run(id, { usd: 1, billing: "subscription" });
    expect(reads.status(caller, id).billing).toBe("subscription");
  });

  it("reads a budget set or cleared a moment ago: the profile, not a copy", async () => {
    const { id, reads, caller } = await setup({ budget: { usdPerDay: 1, tokensPerDay: null } });
    expect(reads.status(caller, id).today.budgetUsd).toBe(1);
    const stored = bed.agents.store.get("u1", id);
    await bed.agents.update(bed.owner(), {
      agentId: id,
      baseRevision: stored?.revision ?? 1,
      input: agentInput({ budget: { usdPerDay: null, tokensPerDay: null } }),
    });
    expect(reads.status(caller, id).today.budgetUsd).toBeNull();
  });

  it("hands the caller to the tasks and triggers link, which lists the newest of the agent", async () => {
    const view = { id: "task-1", agentId: "x" } as unknown as TaskView;
    const statusOf = vi.fn(() => ({ tasks: [view], triggers: [] }));
    const { id, reads, caller } = await setup(
      {},
      {
        automation: { busy: vi.fn(), deleteTriggersOf: vi.fn(), cancelQueuedOf: vi.fn(), statusOf } as never,
      },
    );
    expect(reads.status(caller, id).tasks).toEqual([view]);
    expect(statusOf).toHaveBeenCalledWith(caller, id);
  });

  it("is not_found for an agent that is not the owner's", async () => {
    const { id, reads } = await setup();
    expect(() => reads.status(testCaller({ userId: "u2" }), id)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => reads.status(testCaller(), "ghost-0000")).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});

describe("agents.events (M11R72)", () => {
  it("lists the agent's cards, newest first, and reads another owner's agent as not_found", async () => {
    const { id, reads, events, caller } = await setup();
    events.runCard("u1", id, "t1", "task", { title: "One", state: "done" });
    events.runCard("u1", id, "t2", "schedule", { title: "Two", state: "done" });
    const page = reads.events(caller, { agentId: id });
    expect(page.more).toBe(false);
    expect(page.events.map((event) => event.taskId)).toEqual(["t2", "t1"]);
    expect(() => reads.events(testCaller({ userId: "u2" }), { agentId: id })).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("pages with before", async () => {
    const { id, reads, events, caller } = await setup();
    for (let n = 0; n < 101; n += 1)
      events.runCard("u1", id, `t${n}`, "task", { title: `T${n}`, state: "done" });
    const first = reads.events(caller, { agentId: id });
    expect(first.events).toHaveLength(100);
    expect(first.more).toBe(true);
    const last = first.events[99];
    const next = reads.events(caller, { agentId: id, before: { at: last?.at ?? 0, id: last?.id ?? 0 } });
    expect(next.events.map((event) => event.taskId)).toEqual(["t0"]);
    expect(next.more).toBe(false);
  });
});

describe("fix round 1: a frame under PAGE_BYTES (I4)", () => {
  const big = (n: number) =>
    bed.db.run(
      `INSERT INTO agent_events (agent_id, owner_id, kind, task_id, data, at)
       SELECT id, 'u1', 'delegation', $task, $data, $at FROM agents LIMIT 1`,
      {
        task: `t${n}`,
        at: 1000 + n,
        data: JSON.stringify({
          fromAgentId: "birch-3c4d",
          fromName: "Birch",
          state: "done",
          summary: "x".repeat(16_000),
          clipped: false,
          tainted: false,
          isolated: false,
        }),
      },
    );

  it("cuts a page of big cards at PAGE_BYTES, says more, and the cursor continues without a gap or a repeat", async () => {
    const { id, reads, caller } = await setup();
    for (let n = 0; n < 100; n += 1) big(n);
    const seen: number[] = [];
    let before: { at: number; id: number } | undefined;
    let pages = 0;
    for (;;) {
      const page = reads.events(caller, { agentId: id, ...(before ? { before } : {}) });
      expect(sizeOf(page)).toBeLessThanOrEqual(PAGE_BYTES);
      if (pages === 0) {
        expect(page.events.length).toBeLessThan(100);
        expect(page.more).toBe(true);
      }
      seen.push(...page.events.map((event) => event.id));
      pages += 1;
      if (!page.more || page.next === null) break;
      before = page.next;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
  });

  it("returns a cursor for a page of unreadable rows only", async () => {
    const { id, reads, events, caller } = await setup();
    for (let n = 0; n < 3; n += 1) events.runCard("u1", id, `t${n}`, "task", { title: "T", state: "done" });
    bed.db.run("UPDATE agent_events SET data = '{}'");
    const page = reads.events(caller, { agentId: id });
    expect(page.events).toEqual([]);
    expect(page.next).not.toBeNull();
  });

  it("cuts the status's triggers at PAGE_BYTES and says truncated", async () => {
    const trigger = (n: number) => ({ id: `trg-${n}`, prompt: "p".repeat(60_000) }) as never;
    const statusOf = vi.fn(() => ({ tasks: [], triggers: Array.from({ length: 20 }, (_, n) => trigger(n)) }));
    const { id, reads, caller } = await setup(
      {},
      {
        automation: { busy: vi.fn(), deleteTriggersOf: vi.fn(), cancelQueuedOf: vi.fn(), statusOf } as never,
      },
    );
    const status = reads.status(caller, id);
    expect(status.truncated).toBe(true);
    expect(status.triggers.length).toBeLessThan(20);
    expect(status.triggers.length).toBeGreaterThan(0);
    expect(sizeOf(status)).toBeLessThanOrEqual(PAGE_BYTES);
  });
});
