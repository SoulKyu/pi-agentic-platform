import { afterEach, describe, expect, it } from "vitest";
import { createAgentSpend } from "../runs/index.ts";
import {
  AGENT,
  fakeAgentPorts,
  type FakeAgentPorts,
  insertAgentTrigger,
  TASK,
} from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

type Budget = { usdPerDay: number | null; tokensPerDay: number | null };
const NONE: Budget = { usdPerDay: null, tokensPerDay: null };
const TRIGGER = "trg-agent-1";
const OTHER_TASK = "0b1c2d3e-0002-4000-8000-000000000002";

/** The runner over a real runs table: what an agent spent is what the registry's rows say. */
function setup(budget: Budget | null = NONE): void {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home, createAgentSpend({ db: bed.db, clock: bed.clock }));
  fakes.add(AGENT, "u1", { input: budget === null ? null : { budget } });
  bed.engine.agents.bind(fakes.ports);
  insertAgentTrigger(bed.db, fakes.homeOf(AGENT), { id: TRIGGER });
}

/** One run in the registry, as the observer would have written it (a finished one unless `open`). */
function spend(
  how: {
    session?: string;
    agent?: string | null;
    parent?: string | null;
    owner?: string;
    usd?: number;
    tokens?: number;
    open?: boolean;
  } = {},
): void {
  const at = bed.clock.now();
  bed.db.run(
    `INSERT INTO runs (id, owner_id, session_id, origin, status, started_at, ended_at, input_tokens, cost_usd,
       agent_id, parent_session_id)
     VALUES ($id, $owner, $session, 'schedule', $status, $at, $ended, $tokens, $usd, $agent, $parent)`,
    {
      id: `r-${Math.random().toString(16).slice(2)}`,
      owner: how.owner ?? "u1",
      session: how.session ?? "thread-1",
      status: how.open === true ? "running" : "completed",
      at,
      ended: how.open === true ? null : at,
      tokens: how.tokens ?? 0,
      usd: how.usd ?? 0,
      agent: how.agent === undefined ? AGENT : how.agent,
      parent: how.parent ?? null,
    },
  );
}

const schedule = () => bed.engine.fire(TRIGGER, 1, fireInput({ source: "schedule", gated: true }));
const browser = () => bed.engine.fire(TRIGGER, 1, fireInput({ source: "manual", gated: false }));
const journal = () =>
  bed.db.all<{ verdict: string }>("SELECT verdict FROM trigger_fires WHERE trigger_id = $id ORDER BY id", {
    id: TRIGGER,
  });

describe("no budget is the default (owner m14)", () => {
  it.each([
    ["a budget of nulls", NONE],
    ["no budget in the profile", null],
  ])(
    "lets a scheduled fire run whatever the agent spent with %s, M10's owner budget aside",
    (_name, budget) => {
      setup(budget);
      spend({ usd: 500, tokens: 9_000_000 });
      expect(schedule().verdict).toBe("fired");
    },
  );

  it("still refuses on the owner's own budget", () => {
    setup(NONE);
    bed.settings.value = { ...bed.settings.value, dailyBudgetUsd: 1 };
    bed.runs.spent.value = 2;
    expect(schedule().verdict).toBe("budget");
  });
});

describe("a budget on the agent (M11R74)", () => {
  it("refuses a scheduled fire at the dollar budget with budget, and journals it", () => {
    setup({ usdPerDay: 1, tokensPerDay: null });
    spend({ usd: 0.99 });
    expect(schedule().verdict).toBe("fired");
    spend({ usd: 0.01 });
    expect(schedule()).toEqual({ verdict: "budget" });
    expect(journal().map((line) => line.verdict)).toEqual(["fired", "budget"]);
  });

  it("refuses at the tokens budget too, whichever total is reached first", () => {
    setup({ usdPerDay: 100, tokensPerDay: 1000 });
    spend({ tokens: 1000, usd: 0.01 });
    expect(schedule().verdict).toBe("budget");
  });

  it("runs a browser's fire: the owner's click is counted, never gated", () => {
    setup({ usdPerDay: 1, tokensPerDay: null });
    spend({ usd: 5 });
    expect(schedule().verdict).toBe("budget");
    expect(browser().verdict).toBe("fired");
  });

  it("applies a cleared budget at once: the next scheduled fire runs, no restart", () => {
    setup({ usdPerDay: 1, tokensPerDay: null });
    spend({ usd: 5 });
    expect(schedule().verdict).toBe("budget");
    const agent = fakes.agents.get(AGENT);
    if (agent) agent.input = { budget: NONE };
    expect(schedule().verdict).toBe("fired");
  });

  it("applies a budget that was just set at once", () => {
    setup(NONE);
    spend({ usd: 5 });
    expect(schedule().verdict).toBe("fired");
    const agent = fakes.agents.get(AGENT);
    if (agent) agent.input = { budget: { usdPerDay: 1, tokensPerDay: null } };
    expect(schedule().verdict).toBe("budget");
  });

  it("counts the runs of the agent's thread, its tasks and its children, and only the agent's own", () => {
    setup({ usdPerDay: 1, tokensPerDay: null });
    spend({ usd: 0.3, session: "thread-1" });
    spend({ usd: 0.3, session: "task-1" });
    spend({ usd: 0.3, session: "child-1", parent: "thread-1" });
    spend({ usd: 50, session: "someone-else", agent: "birch-3c4d" });
    spend({ usd: 50, session: "plain", agent: null });
    expect(schedule().verdict).toBe("fired");
    spend({ usd: 0.2, session: "child-2", parent: "thread-1" });
    expect(schedule().verdict).toBe("budget");
  });

  it("counts the live cost of a run that has not ended", () => {
    setup({ usdPerDay: 1, tokensPerDay: null });
    spend({ usd: 1, open: true });
    expect(schedule().verdict).toBe("budget");
  });

  it("is reached before anything runs at a budget of 0: every gated start is refused", async () => {
    setup({ usdPerDay: 0, tokensPerDay: null });
    expect(schedule().verdict).toBe("budget");
    expect(browser().verdict).toBe("fired");
    // A gated task that was admitted before the budget is read again when it starts: it fails with no session.
    bed.db.run("UPDATE tasks SET gated = 1");
    await bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
    expect(bed.db.get("SELECT state, reason, session_id FROM tasks")).toEqual({
      state: "failed",
      reason: "budget",
      session_id: null,
    });
  });

  it("refuses the start of a gated thread task of an over-budget agent, and an isolated one", async () => {
    setup({ usdPerDay: 1, tokensPerDay: null });
    spend({ usd: 1 });
    for (const [id, target] of [
      [TASK, "thread"],
      [OTHER_TASK, "isolated"],
    ] as const)
      bed.engine.store.insert({
        id,
        ownerId: "u1",
        triggerId: null,
        origin: "schedule",
        cwd: fakes.homeOf(AGENT),
        prompt: "Round",
        tainted: false,
        gated: true,
        policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
        title: "Round",
        detail: null,
        retryOf: null,
        retryOnInterrupt: false,
        maxRunMs: 600_000,
        maxRunUsd: null,
        at: bed.clock.now(),
        agentId: AGENT,
        target,
      });
    await bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
    await bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
    expect(bed.db.all("SELECT target, state, reason FROM tasks ORDER BY target")).toEqual([
      { target: "isolated", state: "failed", reason: "budget" },
      { target: "thread", state: "failed", reason: "budget" },
    ]);
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
  });

  it("starts a queued task of the owner's hand even over the budget: counted, never gated", async () => {
    setup({ usdPerDay: 1, tokensPerDay: null });
    spend({ usd: 5 });
    bed.engine.store.insert({
      id: TASK,
      ownerId: "u1",
      triggerId: null,
      origin: "manual",
      cwd: fakes.homeOf(AGENT),
      prompt: "Do this",
      tainted: false,
      gated: false,
      policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
      title: "Do this",
      detail: null,
      retryOf: null,
      retryOnInterrupt: false,
      maxRunMs: 600_000,
      maxRunUsd: null,
      at: bed.clock.now(),
      agentId: AGENT,
      target: "thread",
    });
    await bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
    expect(bed.db.get("SELECT state FROM tasks")).toEqual({ state: "running" });
  });
});

describe("across the run (M11R74)", () => {
  async function runningTask(id: string, gated: boolean, agentId: string | null = AGENT) {
    bed.engine.store.insert({
      id,
      ownerId: "u1",
      triggerId: null,
      origin: gated ? "schedule" : "manual",
      cwd: fakes.homeOf(AGENT),
      prompt: "Round",
      tainted: false,
      gated,
      policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
      title: "Round",
      detail: null,
      retryOf: null,
      retryOnInterrupt: false,
      maxRunMs: 3_600_000,
      maxRunUsd: null,
      at: bed.clock.now(),
      agentId,
      target: "isolated",
    });
    await bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
  }
  const state = (id: string) =>
    bed.db.get<{ state: string; reason: string | null }>("SELECT state, reason FROM tasks WHERE id = $id", {
      id,
    });

  it("aborts the agent's gated running tasks once the tokens budget is reached, and leaves the owner's runs alone", async () => {
    setup({ usdPerDay: null, tokensPerDay: 100 });
    await runningTask(TASK, true);
    await runningTask(OTHER_TASK, false);
    const ownerSession = "owner-chat";
    bed.runs.startRun(ownerSession, null, "u1", "user");
    spend({ tokens: 99, open: true, session: "agent-s1" });
    bed.runs.liveCost("agent-s1", 0.01);
    await bed.clock.advance(0);
    expect(state(TASK)).toEqual({ state: "running", reason: null });
    spend({ tokens: 1, open: true, session: "agent-s1" });
    bed.runs.liveCost("agent-s1", 0.02);
    await bed.clock.advance(0);
    expect(state(TASK)).toEqual({ state: "failed", reason: "budget" });
    expect(bed.runs.port.markEnding).toHaveBeenCalledWith("agent-s1", "budget");
    expect(bed.sessions.abort).toHaveBeenCalledWith("u1", "agent-s1");
    // The click's task (not gated) and the owner's own run are counted and left alone.
    expect(state(OTHER_TASK)).toEqual({ state: "running", reason: null });
    expect(bed.sessions.abort).not.toHaveBeenCalledWith("u1", ownerSession);
    expect(bed.sessions.abort).toHaveBeenCalledTimes(1);
  });

  it("stops nothing for an agent without a budget, whatever it spent", async () => {
    setup(NONE);
    await runningTask(TASK, true);
    spend({ usd: 900, tokens: 900_000_000, open: true, session: "agent-s1" });
    bed.runs.liveCost("agent-s1", 900);
    await bed.clock.advance(0);
    expect(state(TASK)).toEqual({ state: "running", reason: null });
  });

  it("stops the thread task of an agent over its dollar budget, and the thread stays", async () => {
    setup({ usdPerDay: 0.5, tokensPerDay: null });
    bed.engine.store.insert({
      id: TASK,
      ownerId: "u1",
      triggerId: null,
      origin: "schedule",
      cwd: fakes.homeOf(AGENT),
      prompt: "Round",
      tainted: false,
      gated: true,
      policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
      title: "Round",
      detail: null,
      retryOf: null,
      retryOnInterrupt: false,
      maxRunMs: 3_600_000,
      maxRunUsd: null,
      at: bed.clock.now(),
      agentId: AGENT,
      target: "thread",
    });
    await bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
    expect(state(TASK)?.state).toBe("running");
    spend({ usd: 0.6, open: true, session: `thread-${AGENT}` });
    bed.runs.liveCost(`thread-${AGENT}`, 0.6);
    await bed.clock.advance(0);
    expect(state(TASK)).toEqual({ state: "failed", reason: "budget" });
    expect(bed.sessions.archive).not.toHaveBeenCalled();
  });
});

describe("a limited task's resume respects the agent's budget (T11)", () => {
  const taskRow = (gated: boolean) => ({
    gated: gated ? 1 : 0,
    trigger_id: null,
    agent_id: AGENT,
  });

  it("is over once the agent has spent its day, for a gated task only", () => {
    setup({ usdPerDay: 0.5, tokensPerDay: null });
    expect(bed.engine.gates.taskOver("u1", taskRow(true))).toBe(false);
    spend({ usd: 0.6 });
    expect(bed.engine.gates.taskOver("u1", taskRow(true))).toBe(true);
    expect(bed.engine.gates.taskOver("u1", taskRow(false))).toBe(false);
    expect(bed.engine.gates.taskOver("u1", { ...taskRow(true), agent_id: null })).toBe(false);
  });
});
