import { describe, expect, it, vi } from "vitest";
import { type AgentsVm, bindVmCrash } from "./compose-m11-vm.ts";
import { silentLogger } from "./kernel/logger.ts";

/* Mutants (RT-43), run for real in the T15a report: "bind skipped" (the handler never reaches the VM composition). */
const parts = () => ({
  agents: {
    setPaused: vi.fn(),
    port: { ownerOf: () => "u1", get: () => ({ name: "Atlas" }) as never },
  },
  events: { notify: vi.fn(() => true) },
  items: { upsertAgentItem: vi.fn(() => true) },
});

describe("bindVmCrash", () => {
  it("gives the VM composition a handler that pauses the agent and tells the owner", () => {
    const bind = vi.fn();
    const p = parts();
    bindVmCrash({ bindCrashPause: bind } as unknown as AgentsVm, silentLogger, p);
    expect(bind).toHaveBeenCalledTimes(1);
    (bind.mock.calls[0]?.[0] as (agentId: string) => void)("atlas-1a2b");
    expect(p.agents.setPaused).toHaveBeenCalledWith("u1", "atlas-1a2b", true);
    expect(p.items.upsertAgentItem).toHaveBeenCalledTimes(1);
  });

  it("does nothing in host mode", () => {
    expect(() => bindVmCrash(undefined, silentLogger, parts())).not.toThrow();
  });
});
