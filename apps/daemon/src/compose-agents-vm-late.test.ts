import { describe, expect, it, vi } from "vitest";
import {
  type AgentsVmLate,
  bindAgentsVmLate,
  CLAUDE_BRIDGE_PROVIDER,
  POLICY_MAX_MODELS,
  POLICY_RECHECK_MS,
} from "./compose-agents-vm-late.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import type { MirrorHooks } from "./modules/agent-vm/index.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-hooks: the mirror hooks are not bound (or bound to log only) -> "binds the mirror's notice and taint" fails (AVM-E21);
 *  - M-paused: `blocked` ignores the agent's pause -> "blocks a paused agent" fails; M-budget: ignores the budget -> same;
 *  - M-claude: `claude` derived from the models list, or without the token or the profile -> "is claude only when" fails;
 *  - M2: a failed read empties the models -> "keeps the last good models" fails;
 *  - M-cut: more than 512 pairs are sent -> "cuts at 512" fails;
 *  - M-trigger-*: a trigger (models changed, an agent changed, a run ended, the timer) no longer refreshes -> its case fails.
 */
const OWNER = "u1";
const AGENT = "scout-0001";

function bed(
  over: {
    paused?: boolean;
    over?: boolean;
    models?: Array<{ provider: string; id: string }>;
    token?: boolean;
    input?: { model: { provider: string } | null; packages: string[] | null };
  } = {},
) {
  const clock = createFakeClock();
  const hooks: { value: MirrorHooks | null } = { value: null };
  const mirror = { notice: vi.fn(), taint: vi.fn() };
  const listeners = {
    models: [] as Array<() => void>,
    agent: [] as Array<(change: { agentId: string }) => void>,
    start: [] as Array<(sessionId: string) => void>,
    end: [] as Array<(event: { sessionId: string }) => void>,
  };
  const relay = { refresh: vi.fn(), refreshAll: vi.fn() };
  const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
  const state = {
    paused: over.paused ?? false,
    over: over.over ?? false,
    fail: false,
    token: over.token ?? false,
  };
  const late: AgentsVmLate = {
    sessions: { mirror, kindOf: (id) => (id === "s1" ? { agentId: AGENT } : null) },
    pi: {
      models: {
        available: vi.fn(async () => {
          if (state.fail) throw new Error("helper pool is full");
          return {
            models: (over.models ?? [{ provider: "acme", id: "m-1" }]).map((m) => ({
              ...m,
              name: m.id,
              reasoning: false,
            })),
            providers: [],
            origin: "signed-in" as const,
            truncated: false,
          };
        }),
        onChanged: (listener) => void listeners.models.push(listener),
      },
    },
    agents: {
      ownerOf: (id) => (id === AGENT ? OWNER : null),
      get: (_owner, id) =>
        id === AGENT
          ? ({ paused: state.paused, input: over.input ?? { model: null, packages: null } } as never)
          : null,
      onChange: (listener) => (listeners.agent.push(listener as never), () => {}),
    },
    runs: {
      port: {
        onLiveCost: (listener) => (listeners.start.push(listener as never), () => {}),
        onRunEnd: (listener) => (listeners.end.push(listener as never), () => {}),
      },
    },
    automation: { agentTasks: { overBudget: () => state.over } },
  };
  const derived = bindAgentsVmLate(
    {
      clock,
      logger: silentLogger,
      closers,
      relay: relay as never,
      claudeToken: { status: () => (state.token ? "set" : "missing") },
      readOnly: false,
      bindMirrorHooks: (next) => void (hooks.value = next),
    },
    late,
  );
  return { clock, hooks, mirror, listeners, relay, closers, state, derived, late };
}

describe("the mirror hooks (AVM-E21, M-hooks)", () => {
  it("binds the mirror's notice and taint to the sessions, and canWrite to the database mode", () => {
    const { hooks, mirror } = bed();
    hooks.value?.notice("s1", "text");
    hooks.value?.taint("s1");
    expect(mirror.notice).toHaveBeenCalledExactlyOnceWith("s1", "text");
    expect(mirror.taint).toHaveBeenCalledExactlyOnceWith("s1");
    expect(hooks.value?.canWrite()).toBe(true);
  });

  it("cannot write in a read-only database (RT-42)", () => {
    const hooks: { value: MirrorHooks | null } = { value: null };
    bindAgentsVmLate(
      {
        clock: createFakeClock(),
        logger: silentLogger,
        closers: [],
        relay: null,
        claudeToken: { status: () => "missing" },
        readOnly: true,
        bindMirrorHooks: (next) => void (hooks.value = next),
      },
      bed().late,
    );
    expect(hooks.value?.canWrite()).toBe(false);
  });
});

describe("an agent's policy (R13)", () => {
  it("is its picker's models, no bridge, nothing blocked", async () => {
    const { derived } = bed();
    expect(await derived.policyOf(AGENT)).toEqual({
      models: [{ provider: "acme", id: "m-1" }],
      claude: false,
      blocked: null,
    });
  });

  // I1: `models.available` loads no extension, so the bridge is read from the agent's profile and the owner's token.
  it("is claude only when the token is set AND the profile declares the bridge (M-claude)", async () => {
    const packaged = { model: null, packages: ["npm:pi-claude-bridge"] };
    const modelled = { model: { provider: CLAUDE_BRIDGE_PROVIDER }, packages: null };
    const plain = { model: { provider: "acme" }, packages: ["npm:left-pad"] };
    for (const [input, token, expected] of [
      [packaged, true, true],
      [modelled, true, true],
      [packaged, false, false],
      [modelled, false, false],
      [plain, true, false],
    ] as const)
      expect((await bed({ input, token }).derived.policyOf(AGENT)).claude).toBe(expected);
  });

  it("never lists a bridge model among the provider models", async () => {
    const { derived } = bed({
      models: [
        { provider: "acme", id: "m-1" },
        { provider: CLAUDE_BRIDGE_PROVIDER, id: "claude-sonnet-4-5" },
      ],
    });
    expect((await derived.policyOf(AGENT)).models).toEqual([{ provider: "acme", id: "m-1" }]);
  });

  it("keeps the last good models when the read fails, and fails closed when there never was one (M2)", async () => {
    const first = bed();
    await first.derived.policyOf(AGENT);
    first.state.fail = true;
    first.state.paused = true;
    // The models stay; the pause is local and still counts.
    expect(await first.derived.policyOf(AGENT)).toEqual({
      models: [{ provider: "acme", id: "m-1" }],
      claude: false,
      blocked: "paused",
    });
    const never = bed();
    never.state.fail = true;
    await expect(never.derived.policyOf(AGENT)).rejects.toThrow("helper pool is full");
  });

  it("blocks a paused agent, then an agent over its budget (M-paused, M-budget)", async () => {
    const { derived, state } = bed();
    state.paused = true;
    expect((await derived.policyOf(AGENT)).blocked).toBe("paused");
    state.paused = false;
    state.over = true;
    expect((await derived.policyOf(AGENT)).blocked).toBe("budget");
    state.over = false;
    expect((await derived.policyOf(AGENT)).blocked).toBeNull();
  });

  it("allows nothing for an agent nobody knows", async () => {
    expect(await bed().derived.policyOf("ghost-0000")).toEqual({ models: [], claude: false, blocked: null });
  });

  it("cuts the list at 512 pairs (M-cut)", async () => {
    const many = Array.from({ length: POLICY_MAX_MODELS + 50 }, (_, i) => ({
      provider: "acme",
      id: `m-${i}`,
    }));
    const view = await bed({ models: many }).derived.policyOf(AGENT);
    expect(view.models).toHaveLength(POLICY_MAX_MODELS);
  });
});

describe("what makes the relay hear of a change (M-trigger-*)", () => {
  it("refreshes every live agent when the models change", () => {
    const { listeners, relay } = bed();
    listeners.models[0]?.();
    expect(relay.refreshAll).toHaveBeenCalledTimes(1);
  });

  it("refreshes the agent that was edited, paused or deleted", () => {
    const { listeners, relay } = bed();
    listeners.agent[0]?.({ agentId: AGENT });
    expect(relay.refresh).toHaveBeenCalledExactlyOnceWith(AGENT);
  });

  it("refreshes the agent of a run that ended (its spend moved), not a session that is no agent's", () => {
    const { listeners, relay } = bed();
    listeners.end[0]?.({ sessionId: "s1" });
    listeners.end[0]?.({ sessionId: "stranger" });
    expect(relay.refresh).toHaveBeenCalledExactlyOnceWith(AGENT);
  });

  it("counts the turns an agent's workers report in the window, and the window's end starts again (I4)", () => {
    const { listeners, derived } = bed();
    listeners.start[0]?.("s1");
    listeners.start[0]?.("s1");
    listeners.start[0]?.("stranger");
    expect(derived.turnsOf(AGENT)).toBe(2);
    expect(derived.turnsOf(AGENT)).toBe(2);
    derived.windowEnded();
    expect(derived.turnsOf(AGENT)).toBe(0);
  });

  it("looks at every live agent again each minute (a budget resets at midnight), until it is closed", async () => {
    const { clock, relay, closers } = bed();
    await clock.advance(POLICY_RECHECK_MS);
    expect(relay.refreshAll).toHaveBeenCalledTimes(1);
    await clock.advance(POLICY_RECHECK_MS);
    expect(relay.refreshAll).toHaveBeenCalledTimes(2);
    await closers.find((closer) => closer.name === "agent_relay_policy")?.close();
    await clock.advance(10 * POLICY_RECHECK_MS);
    expect(relay.refreshAll).toHaveBeenCalledTimes(2);
  });

  it("wires no trigger without a relay, and still answers the policy", async () => {
    const { late } = bed();
    const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
    const derived = bindAgentsVmLate(
      {
        clock: createFakeClock(),
        logger: silentLogger,
        closers,
        relay: null,
        claudeToken: { status: () => "missing" },
        readOnly: false,
        bindMirrorHooks: () => {},
      },
      late,
    );
    expect(closers).toEqual([]);
    expect((await derived.policyOf(AGENT)).blocked).toBeNull();
  });
});
