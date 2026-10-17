import { AgentInput, PapError, type PlatformError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { PlatformContext } from "../platform/index.ts";
import { PlatformRefusal } from "../platform/index.ts";
import { createDelegate, DELEGATIONS_PER_HOUR, DELEGATIONS_QUEUED_PER_TARGET } from "./ops-delegate.ts";
import type { AgentTasksPort, DelegationRequest } from "./task-port.ts";
import type { AgentRecord } from "./store.ts";

const ATLAS = "atlas-1a2b";
const SCOUT = "scout-3c4d";
const HOUR = 3_600_000;

const record = (id: string, name: string, over: Partial<AgentRecord> = {}, accepts = true): AgentRecord => ({
  id,
  ownerId: "u1",
  name,
  input: AgentInput.parse({ name, acceptsDelegation: accepts }),
  threadSessionId: null,
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function setup(options: { scout?: Partial<AgentRecord>; accepts?: boolean; scoutInput?: null } = {}) {
  const clock = createFakeClock();
  const log: string[] = [];
  const agents = new Map<string, AgentRecord>([
    [ATLAS, record(ATLAS, "Atlas")],
    [SCOUT, record(SCOUT, "Scout", options.scout, options.accepts ?? true)],
  ]);
  if (options.scoutInput === null) agents.set(SCOUT, { ...(agents.get(SCOUT) as AgentRecord), input: null });
  const state = { requester: null as string | null, since: 0, queued: 0, over: false };
  let made = 0;
  const delegate = vi.fn((request: DelegationRequest) => {
    log.push("delegate");
    return { taskId: `task-${++made}`, request };
  });
  const tasks: Pick<
    AgentTasksPort,
    "runningRequester" | "delegationsSince" | "queuedDelegationsTo" | "overBudget" | "delegate"
  > = {
    runningRequester: (_owner, agentId) => (log.push(`depth:${agentId}`), state.requester),
    delegationsSince: (_owner, _agent, since) => (log.push(`rate:${clock.now() - since}`), state.since),
    queuedDelegationsTo: (_owner, agentId) => (log.push(`queue:${agentId}`), state.queued),
    overBudget: (_owner, agentId) => (log.push(`budget:${agentId}`), state.over),
    delegate,
  };
  const handler = createDelegate({
    clock,
    agents: {
      get: (ownerId, id) => (ownerId === "u1" ? (agents.get(id) ?? null) : null),
      byName: (ownerId, name) =>
        ownerId === "u1"
          ? ([...agents.values()].find((agent) => agent.name.toLowerCase() === name.toLowerCase()) ?? null)
          : null,
    },
    tasks,
  });
  const ctx = (over: Partial<PlatformContext> = {}): PlatformContext => ({
    ownerId: "u1",
    sessionId: "s1",
    type: "agent-thread",
    tainted: false,
    agentId: ATLAS,
    signal: new AbortController().signal,
    ...over,
  });
  const codeOf = async (args: { agent: string; task: string }, over: Partial<PlatformContext> = {}) => {
    try {
      await handler(args, ctx(over));
      return "ok";
    } catch (error) {
      if (error instanceof PlatformRefusal) return error.code;
      throw error;
    }
  };
  return { clock, log, agents, state, delegate, handler, ctx, codeOf };
}

const ASK = { agent: "Scout", task: "Summarise the open issues." };

describe("agent.delegate refusals (M11R78)", () => {
  it("refuses a delegation to itself, in any case, before it looks anything else up", async () => {
    const { codeOf, log } = setup();
    expect(await codeOf({ agent: "atlas", task: "x" })).toBe("refused" satisfies PlatformError);
    expect(await codeOf({ agent: "ATLAS", task: "x" })).toBe("refused");
    expect(log).toEqual([]);
  });

  it("answers not_found for a name that is not one of the owner's agents", async () => {
    const { codeOf, log } = setup();
    expect(await codeOf({ agent: "Nobody", task: "x" })).toBe("not_found");
    expect(log).toEqual([]);
  });

  it("answers not_found when the calling agent itself is gone", async () => {
    const { codeOf } = setup();
    expect(await codeOf(ASK, { agentId: "ghost-0000" })).toBe("not_found");
    expect(await codeOf(ASK, { agentId: null })).toBe("not_found");
  });

  it("does not find another owner's agent by name", async () => {
    const { codeOf } = setup();
    expect(await codeOf(ASK, { ownerId: "u2" })).toBe("not_found");
  });

  it("refuses an agent that does not accept delegation, or whose profile does not read", async () => {
    expect(await setup({ accepts: false }).codeOf(ASK)).toBe("refused");
    const unreadable = setup({ scoutInput: null });
    expect(await unreadable.codeOf(ASK)).toBe("refused");
    expect(unreadable.log).toEqual([]);
  });

  it("refuses when the caller's running thread task was itself delegated (depth 1)", async () => {
    const { codeOf, state, log } = setup();
    state.requester = "someone-0001";
    expect(await codeOf(ASK)).toBe("refused");
    expect(log).toEqual([`depth:${ATLAS}`]);
  });

  it("answers paused for a paused or a quarantined target", async () => {
    expect(await setup({ scout: { paused: true } }).codeOf(ASK)).toBe("paused");
    expect(await setup({ scout: { quarantinedAt: 5 } }).codeOf(ASK)).toBe("paused");
  });

  it("allows 10 an hour from the caller and answers rate_limited for the eleventh", async () => {
    const { codeOf, state, log } = setup();
    state.since = DELEGATIONS_PER_HOUR - 1;
    expect(await codeOf(ASK)).toBe("ok");
    state.since = DELEGATIONS_PER_HOUR;
    log.length = 0;
    expect(await codeOf(ASK)).toBe("rate_limited");
    expect(log).toEqual([`depth:${ATLAS}`, `rate:${HOUR}`]);
  });

  it("answers limit_reached when 20 delegations already wait for the target, whoever asked for them", async () => {
    const { codeOf, state, delegate, log } = setup();
    expect(DELEGATIONS_QUEUED_PER_TARGET).toBe(20);
    state.queued = DELEGATIONS_QUEUED_PER_TARGET - 1;
    expect(await codeOf(ASK)).toBe("ok");
    state.queued = DELEGATIONS_QUEUED_PER_TARGET;
    delegate.mockClear();
    log.length = 0;
    expect(await codeOf(ASK)).toBe("limit_reached");
    expect(delegate).not.toHaveBeenCalled();
    expect(log).toEqual([`depth:${ATLAS}`, `rate:${HOUR}`, `queue:${SCOUT}`]);
  });

  it("answers budget when the target is over its line", async () => {
    const { codeOf, state, delegate } = setup();
    state.over = true;
    expect(await codeOf(ASK)).toBe("budget");
    expect(delegate).not.toHaveBeenCalled();
  });

  it("checks in the ruled order: self, unknown, opt-in, depth, paused, rate, budget", async () => {
    // Everything is wrong at once; remove the wrongs from the front and the next code shows.
    const world = setup({ accepts: false, scout: { paused: true } });
    world.state.requester = "someone-0001";
    world.state.since = 99;
    world.state.over = true;
    expect(await world.codeOf({ agent: "Atlas", task: "x" })).toBe("refused");
    expect(await world.codeOf({ agent: "Nobody", task: "x" })).toBe("not_found");
    expect(await world.codeOf(ASK)).toBe("refused"); // opt-in
    expect(world.log).toEqual([]);
    world.agents.set(SCOUT, record(SCOUT, "Scout", { paused: true }, true));
    expect(await world.codeOf(ASK)).toBe("refused"); // depth
    expect(world.log).toEqual([`depth:${ATLAS}`]);
    world.state.requester = null;
    world.log.length = 0;
    expect(await world.codeOf(ASK)).toBe("paused");
    expect(world.log).toEqual([`depth:${ATLAS}`]);
    world.agents.set(SCOUT, record(SCOUT, "Scout"));
    world.log.length = 0;
    expect(await world.codeOf(ASK)).toBe("rate_limited");
    expect(world.log).toEqual([`depth:${ATLAS}`, `rate:${HOUR}`]);
    world.state.since = 0;
    world.state.queued = 20;
    world.log.length = 0;
    expect(await world.codeOf(ASK)).toBe("limit_reached");
    expect(world.log).toEqual([`depth:${ATLAS}`, `rate:${HOUR}`, `queue:${SCOUT}`]);
    world.state.queued = 0;
    world.log.length = 0;
    expect(await world.codeOf(ASK)).toBe("budget");
    expect(world.log).toEqual([`depth:${ATLAS}`, `rate:${HOUR}`, `queue:${SCOUT}`, `budget:${SCOUT}`]);
    world.state.over = false;
    world.log.length = 0;
    expect(await world.codeOf(ASK)).toBe("ok");
    expect(world.log).toEqual([
      `depth:${ATLAS}`,
      `rate:${HOUR}`,
      `queue:${SCOUT}`,
      `budget:${SCOUT}`,
      "delegate",
    ]);
  });
});

describe("agent.delegate (M11R78, owner m18)", () => {
  it("an untainted caller makes a thread task for the target; the result is the task id", async () => {
    const { handler, ctx, delegate } = setup();
    const result = await handler(ASK, ctx());
    expect(result).toEqual({ taskId: "task-1" });
    expect(delegate).toHaveBeenCalledWith({
      ownerId: "u1",
      requesterId: ATLAS,
      targetId: SCOUT,
      text: "Summarise the open issues.",
      isolated: false,
    });
  });

  it("a tainted caller (its Allow once checked by the dispatcher) makes an isolated task, never a thread one", async () => {
    const { handler, ctx, delegate } = setup();
    await handler(ASK, ctx({ tainted: true }));
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate).toHaveBeenCalledWith(expect.objectContaining({ isolated: true, targetId: SCOUT }));
  });

  it.each(["chat", "none"] as const)(
    "refuses a tainted caller when the target's preset is %s: read tools would be wider than its own thread (m3)",
    async (preset) => {
      const world = setup();
      world.agents.set(SCOUT, {
        ...(world.agents.get(SCOUT) as AgentRecord),
        input: AgentInput.parse({ name: "Scout", acceptsDelegation: true, preset }),
      });
      expect(await world.codeOf(ASK, { tainted: true })).toBe("refused");
      expect(world.delegate).not.toHaveBeenCalled();
      // An untainted request is a prompt in its thread, which has the same tools as the owner's.
      expect(await world.codeOf(ASK)).toBe("ok");
    },
  );

  it("finds the target in any case and keeps the target's id, not the typed name", async () => {
    const { handler, ctx, delegate } = setup();
    await handler({ agent: "sCoUt", task: "x" }, ctx());
    expect(delegate).toHaveBeenCalledWith(expect.objectContaining({ targetId: SCOUT }));
  });

  it("answers not_found when the task maker finds an agent gone; any other failure is not turned into a refusal", async () => {
    const world = setup();
    world.delegate.mockImplementationOnce(() => {
      throw new PapError("not_found");
    });
    expect(await world.codeOf(ASK)).toBe("not_found");
    world.delegate.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(world.codeOf(ASK)).rejects.toThrow("disk full");
  });
});
