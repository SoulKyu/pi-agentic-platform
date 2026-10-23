import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { HealthEvents } from "../health/index.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";
import { createCrashPause } from "./vm-crash.ts";

/*
 * Mutants (RT-43), run for real in the T15a report: "pause not persisted" (the paused case), "no Inbox item" (the item case),
 * "pause bypasses the registry" (the listener case: the relay learns of the pause through `onChange`), "unknown agent throws".
 */
let bed: AgentsBed;
afterEach(() => bed.dispose());

const TEXT = "Atlas s'est arrêté trois fois en dix minutes ; il est en pause.";

async function setup(health?: Pick<HealthEvents, "emit">) {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput({ name: "Atlas" }));
  const events = { notify: vi.fn(() => true) };
  const items = { upsertAgentItem: vi.fn(() => true) };
  const crash = createCrashPause({ agents: bed.agents, events, items, logger: silentLogger, health });
  return { id, events, items, crash };
}

describe("three crashes in ten minutes (RT-40)", () => {
  it("pauses the agent for good, posts one Inbox item and one card in its thread", async () => {
    const { id, events, items, crash } = await setup();
    const changes: Array<{ agentId: string; removed: boolean }> = [];
    bed.agents.port.onChange((change) => void changes.push(change));
    crash(id);
    expect(bed.agents.port.get("u1", id)?.paused).toBe(true);
    expect(changes).toEqual([{ ownerId: "u1", agentId: id, removed: false }]);
    expect(events.notify).toHaveBeenCalledTimes(1);
    expect(events.notify).toHaveBeenCalledWith("u1", id, { text: TEXT, itemId: expect.any(String) });
    expect(items.upsertAgentItem).toHaveBeenCalledTimes(1);
    expect(items.upsertAgentItem).toHaveBeenCalledWith({
      ownerId: "u1",
      kind: "agent_notify",
      agentId: id,
      refId: (events.notify.mock.calls[0] as unknown as [string, string, { itemId: string }])[2].itemId,
      detail: TEXT,
      toHandle: false,
    });
  });

  it("is cleared by the owner's Resume as any pause is", async () => {
    const { id, crash } = await setup();
    crash(id);
    bed.agents.pause(bed.owner(), id, false);
    expect(bed.agents.port.get("u1", id)?.paused).toBe(false);
  });

  it("emits an agent health event when the crashes pause the agent", async () => {
    const health = { emit: vi.fn() };
    const { id, crash } = await setup(health);
    crash(id);
    expect(health.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent", code: "agent_crash_paused" }),
    );
  });

  it("does nothing, and does not throw, for an agent that is gone", async () => {
    const { events, items, crash } = await setup();
    expect(() => crash("nobody-0000")).not.toThrow();
    expect(events.notify).not.toHaveBeenCalled();
    expect(items.upsertAgentItem).not.toHaveBeenCalled();
  });
});
