import { describe, expect, it } from "vitest";
import { type AgentsVmLate, bindAgentsVmLate } from "./compose-agents-vm-late.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";

/** Mutant M-owner: the owner's list is not used for an agent without one -> "falls back to the owner's list" fails. */
function hostsOf(input: { allowHosts: string[] | null } | null, ownerHosts?: AgentsVmLate["ownerHosts"]) {
  const late = {
    sessions: { mirror: { notice: () => {}, taint: () => {} }, kindOf: () => null },
    pi: {
      plugins: { sourcesOf: async () => null, check: async () => {} },
      models: { available: async () => ({}), onChanged: () => {} },
    },
    agents: {
      list: () => [],
      ownerOf: (id: string) => (id === "scout-0001" ? "u1" : null),
      get: (_owner: string, id: string) => (id === "scout-0001" ? { input } : null),
      onChange: () => () => {},
    },
    ...(ownerHosts ? { ownerHosts } : {}),
    runs: { port: { onLiveCost: () => () => {}, onRunEnd: () => () => {} } },
    automation: { agentTasks: { overBudget: () => false } },
  } as unknown as AgentsVmLate;
  return bindAgentsVmLate(
    {
      clock: createFakeClock(),
      logger: silentLogger,
      closers: [],
      relay: null,
      claudeToken: { status: () => "missing" },
      readOnly: false,
      bindMirrorHooks: () => {},
    },
    late,
  ).hostsOf;
}

describe("the host list the VMs' proxy judges by", () => {
  it("is the agent's own list, even an empty one", () => {
    expect(hostsOf({ allowHosts: ["k8s.lan:6443"] }, () => ["owner.example.com"])("scout-0001")).toEqual([
      "k8s.lan:6443",
    ]);
    expect(hostsOf({ allowHosts: [] }, () => ["owner.example.com"])("scout-0001")).toEqual([]);
  });

  it("falls back to the owner's list when the agent has none, and to nothing when the owner has none", () => {
    expect(hostsOf({ allowHosts: null }, () => ["owner.example.com"])("scout-0001")).toEqual([
      "owner.example.com",
    ]);
    expect(hostsOf({ allowHosts: null }, () => null)("scout-0001")).toEqual([]);
    expect(hostsOf({ allowHosts: null })("scout-0001")).toEqual([]);
  });

  it("is null for an agent that is unknown or has no readable profile", () => {
    expect(hostsOf({ allowHosts: [] })("ghost-0000")).toBeNull();
    expect(hostsOf(null)("scout-0001")).toBeNull();
  });
});
