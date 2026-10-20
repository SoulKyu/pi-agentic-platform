import { afterEach, describe, expect, it } from "vitest";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

describe("the owner's trash entry (J1b)", () => {
  it("lists a deleted agent after the delete, for its owner only, and not an agent that exists", async () => {
    bed = createAgentsBed();
    const gone = await bed.agents.create(bed.owner(), agentInput({ name: "Atlas" }));
    await bed.agents.create(bed.owner(), agentInput({ name: "Borea" }));
    expect(bed.agents.trash(bed.owner())).toEqual({ agents: [] });
    await bed.agents.remove(bed.owner(), gone.id);
    expect(bed.agents.trash(bed.owner())).toEqual({
      agents: [{ agentId: gone.id, name: "Atlas", deletedAt: bed.clock.now() }],
    });
    expect(bed.agents.trash(bed.owner({ userId: "u2" }))).toEqual({ agents: [] });
  });

  it("leaves a half-done delete out: the row is quarantined, not trashed", async () => {
    bed = createAgentsBed();
    const view = await bed.agents.create(bed.owner(), agentInput());
    bed.agents.store.quarantine("u1", view.id, bed.clock.now());
    expect(bed.agents.trash(bed.owner())).toEqual({ agents: [] });
  });
});
