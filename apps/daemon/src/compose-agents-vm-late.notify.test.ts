import { sharesAllProviders } from "./testing/shares-all.ts";
import { describe, expect, it, vi } from "vitest";
import { type AgentsVmLate, bindAgentsVmLate } from "./compose-agents-vm-late.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";

/*
 * Mutants (RT-43), run for real in the T15a report: "notice to the wrong session" (a stray id), "notice for an unknown agent
 * posts" (the unknown case), "no thread posts to undefined" (the no-thread case).
 */
function bed(thread: string | null, known = true) {
  const mirror = { notice: vi.fn(), taint: vi.fn() };
  const late = {
    sessions: { mirror, kindOf: () => null },
    providers: sharesAllProviders,
    pi: {
      plugins: { sourcesOf: async () => null, check: async () => {} },
      models: { available: async () => ({ models: [] }), onChanged: () => {} },
    },
    agents: {
      ownerOf: (id: string) => (known && id === "scout-0001" ? "u1" : null),
      get: () => ({ threadSessionId: thread, paused: false, input: null }),
      onChange: () => () => {},
    },
    runs: { port: { onLiveCost: () => () => {}, onRunEnd: () => () => {} } },
    automation: { agentTasks: { overBudget: () => false, ownerOverBudget: () => false } },
  } as unknown as AgentsVmLate;
  const derived = bindAgentsVmLate(
    {
      clock: createFakeClock(),
      logger: silentLogger,
      closers: [],
      relay: null,
      claudeToken: { get: () => null },
      readOnly: false,
      bindMirrorHooks: () => {},
      bindTaint: () => {},
    },
    late,
  );
  return { derived, mirror };
}

describe("notify (the thread notices of the image policy and the disk grow)", () => {
  it("posts into the agent's thread, as a notice of its session", () => {
    const { derived, mirror } = bed("s-thread");
    derived.notify("scout-0001", "texte");
    expect(mirror.notice).toHaveBeenCalledWith("s-thread", "texte");
  });
  it("posts nothing, and does not throw, for an agent with no thread yet or an unknown agent", () => {
    const none = bed(null);
    expect(() => none.derived.notify("scout-0001", "texte")).not.toThrow();
    expect(none.mirror.notice).not.toHaveBeenCalled();
    const unknown = bed("s-thread", false);
    unknown.derived.notify("scout-0001", "texte");
    expect(unknown.mirror.notice).not.toHaveBeenCalled();
  });
});
