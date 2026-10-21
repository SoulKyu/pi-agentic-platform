import { describe, expect, it, vi } from "vitest";
import { type AgentsVm, bindVmCrash } from "./compose-m11-vm.ts";
import { silentLogger } from "./kernel/logger.ts";

/* Mutants (RT-43), run for real in the T15a report: "bind skipped" (the handler never reaches the VM composition). */
const parts = () => ({
  agents: {
    setPaused: vi.fn(),
    port: { ownerOf: () => "u1", get: () => ({ name: "Atlas" }) as never },
  },
  events: { notify: vi.fn(() => true), write: vi.fn(() => 7), update: vi.fn(() => true) },
  items: { upsertAgentItem: vi.fn(() => true) },
  clock: { now: () => 1_000, setTimeout: () => ({ id: 1 }), clearTimeout: () => {} },
});

describe("bindVmCrash", () => {
  it("gives the VM composition a handler that pauses the agent and tells the owner", () => {
    const bind = vi.fn();
    const p = parts();
    bindVmCrash({ bindCrashPause: bind, bindRefusals: vi.fn() } as unknown as AgentsVm, silentLogger, p);
    expect(bind).toHaveBeenCalledTimes(1);
    (bind.mock.calls[0]?.[0] as (agentId: string) => void)("atlas-1a2b");
    expect(p.agents.setPaused).toHaveBeenCalledWith("u1", "atlas-1a2b", true);
    expect(p.items.upsertAgentItem).toHaveBeenCalledTimes(1);
  });

  it("gives the proxy a sink that writes the refused host's card and Inbox item", () => {
    const bind = vi.fn();
    const p = parts();
    bindVmCrash({ bindCrashPause: vi.fn(), bindRefusals: bind } as unknown as AgentsVm, silentLogger, p);
    (bind.mock.calls[0]?.[0] as (refusal: unknown) => void)({
      agentId: "atlas-1a2b",
      launchId: "l1",
      source: "thread",
      host: "prometheus.lan",
      port: 9090,
      reason: "not_listed",
      address: null,
    });
    expect(p.events.write).toHaveBeenCalledWith(
      "u1",
      "atlas-1a2b",
      "egress_refused",
      null,
      expect.objectContaining({ host: "prometheus.lan", port: 9090, count: 1, source: "thread" }),
    );
    expect(p.items.upsertAgentItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent_egress", refId: "7", toHandle: false }),
    );
  });

  it("does nothing in host mode", () => {
    expect(() => bindVmCrash(undefined, silentLogger, parts())).not.toThrow();
  });
});
