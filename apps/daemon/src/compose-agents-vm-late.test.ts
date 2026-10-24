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
    quarantinedAt: null as number | null,
  };
  const late: AgentsVmLate = {
    sessions: { mirror, kindOf: (id) => (id === "s1" ? { agentId: AGENT } : null) },
    pi: {
      // The tests give the picks as the sources themselves: the identity stands for the helper's resolution.
      plugins: { sourcesOf: async (ids) => (ids === null ? null : [...ids]), check: async () => {} },
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
      list: () => [],
      ownerOf: (id) => (id === AGENT ? OWNER : null),
      get: (_owner, id) =>
        id === AGENT
          ? ({
              paused: state.paused,
              quarantinedAt: state.quarantinedAt,
              input: over.input ?? { model: null, packages: null },
            } as never)
          : null,
      onChange: (listener) => (listeners.agent.push(listener as never), () => {}),
    },
    runs: {
      port: {
        onLiveCost: (listener) => (listeners.start.push(listener as never), () => {}),
        onRunEnd: (listener) => (listeners.end.push(listener as never), () => {}),
      },
    },
    automation: { agentTasks: { overBudget: () => state.over, ownerOverBudget: () => state.over } },
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
      bindTaint: () => {},
    },
    late,
  );
  return { clock, hooks, mirror, listeners, relay, closers, state, derived, late };
}

describe("the mirror hooks (AVM-E21, M-hooks)", () => {
  it("binds the mirror's notice and taint to the sessions, and canWrite to the database mode", () => {
    const { hooks, mirror } = bed();
    hooks.value?.notice("s1", "text");
    hooks.value?.notice("s2", "now text", true);
    hooks.value?.taint("s1");
    expect(mirror.notice.mock.calls).toEqual([
      ["s1", "text", undefined],
      ["s2", "now text", true],
    ]);
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
        bindTaint: () => {},
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

  // AVM-E41 m6. Mutant: the match is `/pi-claude-bridge/.test(source)` again -> "a package whose name only contains it" fails.
  it("takes the bridge package by its exact name, not by a substring (m6)", async () => {
    const claudeFor = async (source: string) =>
      (await bed({ token: true, input: { model: null, packages: [source] } }).derived.policyOf(AGENT)).claude;
    for (const source of [
      "npm:pi-claude-bridge",
      "npm:pi-claude-bridge@1.2.0",
      "git:github.com/acme/pi-claude-bridge",
      "git:github.com/acme/pi-claude-bridge@v1",
      "git@github.com:acme/pi-claude-bridge.git",
      "https://github.com/acme/pi-claude-bridge.git",
      "/home/me/pkgs/pi-claude-bridge",
      "../pkgs/pi-claude-bridge/",
    ])
      expect(await claudeFor(source), source).toBe(true);
    for (const source of [
      "npm:not-pi-claude-bridge",
      "npm:pi-claude-bridge-fork",
      "npm:pi-claude-bridge-extra@1.0.0",
      "npm:@acme/pi-claude-bridge",
      "git:github.com/acme/pi-claude-bridge-fork",
      "git:github.com/pi-claude-bridge/other",
      "/home/me/pi-claude-bridge/tools",
      "npm:left-pad",
    ])
      expect(await claudeFor(source), source).toBe(false);
  });

  it("reads the bridge from the sources the picks resolve to, not from the ids (AVM-E33)", async () => {
    const { derived, late } = bed({ token: true, input: { model: null, packages: ["f".repeat(32)] } });
    late.pi.plugins.sourcesOf = async () => ["npm:pi-claude-bridge"];
    expect((await derived.policyOf(AGENT)).claude).toBe(true);
  });

  // AVM-E42 I2. Mutants: no last value -> "keeps the last known declaration" fails; a helper run per evaluation -> "reads the picks once" fails;
  // the read never refreshes after the models changed -> "reads again after the models changed" fails.
  describe("the bridge declaration (I2)", () => {
    const withReads = (reads: Array<string[] | Error>) => {
      const { derived, late, listeners, clock } = bed({
        token: true,
        input: { model: null, packages: ["f".repeat(32)] },
      });
      const calls = { n: 0 };
      late.pi.plugins.sourcesOf = async () => {
        const next = reads[Math.min(calls.n++, reads.length - 1)] as string[] | Error;
        if (next instanceof Error) throw next;
        return next;
      };
      return { derived, listeners, calls, clock };
    };

    it("reads the picks once, not at every evaluation", async () => {
      const { derived, calls } = withReads([["npm:pi-claude-bridge"]]);
      for (let i = 0; i < 3; i++) expect((await derived.policyOf(AGENT)).claude).toBe(true);
      expect(calls.n).toBe(1);
    });

    it("reads again after the models changed, and keeps the last known declaration when that read fails", async () => {
      const { derived, listeners, calls } = withReads([
        ["npm:pi-claude-bridge"],
        new Error("helper pool is full"),
      ]);
      expect((await derived.policyOf(AGENT)).claude).toBe(true);
      for (const listener of listeners.models) listener();
      expect((await derived.policyOf(AGENT)).claude).toBe(true);
      expect(calls.n).toBe(2);
    });

    it("takes the new value when the re-read works", async () => {
      const { derived, listeners } = withReads([["npm:pi-claude-bridge"], ["npm:left-pad"]]);
      expect((await derived.policyOf(AGENT)).claude).toBe(true);
      for (const listener of listeners.models) listener();
      expect((await derived.policyOf(AGENT)).claude).toBe(false);
    });

    // AVM-E45 N1. Mutants: the `at` bound dropped -> "a profile that lost the bridge" fails; the agent-change mark dropped -> the next case fails.
    it("a profile that lost the bridge gets claude false within a minute, with no models or picks change", async () => {
      const { derived, calls, clock } = withReads([["npm:pi-claude-bridge"], ["npm:left-pad"]]);
      expect((await derived.policyOf(AGENT)).claude).toBe(true);
      await clock.advance(POLICY_RECHECK_MS - 1);
      expect((await derived.policyOf(AGENT)).claude).toBe(true);
      expect(calls.n).toBe(1);
      await clock.advance(1);
      expect((await derived.policyOf(AGENT)).claude).toBe(false);
      expect(calls.n).toBe(2);
    });

    it("reads again at once when the agent changed", async () => {
      const { derived, listeners, calls } = withReads([["npm:pi-claude-bridge"], ["npm:left-pad"]]);
      expect((await derived.policyOf(AGENT)).claude).toBe(true);
      for (const listener of listeners.agent) listener({ agentId: AGENT });
      expect((await derived.policyOf(AGENT)).claude).toBe(false);
      expect(calls.n).toBe(2);
    });

    it("fails closed when no declaration was ever read", async () => {
      const { derived } = withReads([new Error("helper pool is full")]);
      expect((await derived.policyOf(AGENT)).claude).toBe(false);
    });
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
    for (const listener of listeners.models) listener();
    expect(relay.refreshAll).toHaveBeenCalledTimes(1);
  });

  it("refreshes the agent that was edited, paused or deleted", () => {
    const { listeners, relay } = bed();
    for (const listener of listeners.agent) listener({ agentId: AGENT });
    expect(relay.refresh).toHaveBeenCalledExactlyOnceWith({ kind: "agent", id: AGENT });
  });

  it("refreshes the agent of a run that ended (its spend moved), not a session that is no agent's", () => {
    const { listeners, relay } = bed();
    listeners.end[0]?.({ sessionId: "s1" });
    listeners.end[0]?.({ sessionId: "stranger" });
    expect(relay.refresh).toHaveBeenCalledExactlyOnceWith({ kind: "agent", id: AGENT });
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
        bindTaint: () => {},
      },
      late,
    );
    expect(closers).toEqual([]);
    expect((await derived.policyOf(AGENT)).blocked).toBeNull();
  });
});

// S1 item 5. Mutants: `agentOpen` ignoring the quarantine, or the missing agent -> its case fails.
describe("agentOpen: the check a launch repeats after its image wait", () => {
  it("lets an agent through, refuses a quarantined one agent_paused and a missing one not_found", () => {
    const { derived, state } = bed();
    expect(() => derived.agentOpen(OWNER, AGENT)).not.toThrow();
    state.quarantinedAt = 1_760_000_000_000;
    expect(() => derived.agentOpen(OWNER, AGENT)).toThrow(
      expect.objectContaining({ code: "agent_paused" }) as Error,
    );
    expect(() => derived.agentOpen(OWNER, "gone-0009")).toThrow(
      expect.objectContaining({ code: "not_found" }) as Error,
    );
  });
});
