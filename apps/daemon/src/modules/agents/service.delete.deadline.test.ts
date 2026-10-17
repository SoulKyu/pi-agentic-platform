import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANCEL_QUEUED_MS } from "./service.ts";
import { agentInput, createAgentsBed, type AgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);

describe("delete: the queue is cancelled within a deadline (Task 10 carry 1)", () => {
  it("fails with command_failed when cancelQueuedOf never answers, and frees the agent for a later delete", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.owner(), agentInput());
    const stuck = vi.fn(() => new Promise<void>(() => {}));
    bed.agents.setLinks({
      automation: { busy: () => false, deleteTriggersOf: () => {}, cancelQueuedOf: stuck },
    });
    const first = refusalOf(() => bed.agents.remove(bed.owner(), "atlas-0000"));
    await vi.waitFor(() => expect(stuck).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(bed.guard.deleting.has("atlas-0000")).toBe(true);
    await bed.clock.advance(CANCEL_QUEUED_MS);
    expect(await first).toBe("command_failed");
    expect(bed.guard.deleting.has("atlas-0000")).toBe(false);
    expect(existsSync(join(bed.papHome, "agents", "atlas-0000"))).toBe(true);
    expect(bed.logs.some((line) => line.msg === "agent_delete_failed")).toBe(true);
  });

  it("does not wait longer than the answer: a queue cancelled in time deletes the agent", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.owner(), agentInput());
    const cancel = vi.fn(async () => {});
    bed.agents.setLinks({
      automation: { busy: () => false, deleteTriggersOf: () => {}, cancelQueuedOf: cancel },
    });
    expect(await bed.agents.remove(bed.owner(), "atlas-0000")).toMatchObject({
      trashedAs: expect.any(String),
    });
    expect(cancel).toHaveBeenCalledWith("u1", "atlas-0000");
    expect(bed.agents.port.get("u1", "atlas-0000")).toBeNull();
  });

  it("clears its timer when the queue answers first", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.owner(), agentInput());
    bed.agents.setLinks({
      automation: { busy: () => false, deleteTriggersOf: () => {}, cancelQueuedOf: async () => {} },
    });
    await bed.agents.remove(bed.owner(), "atlas-0000");
    expect(bed.clock.pending()).toBe(0);
  });
});
