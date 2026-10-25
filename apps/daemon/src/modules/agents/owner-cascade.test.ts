import { afterEach, describe, expect, it } from "vitest";
import { createAgentsOwnerCascade } from "./owner-cascade.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

describe("agents owner cascade (A5b)", () => {
  it("trashAll sends every agent of the owner to the agent trash and leaves another owner's alone", async () => {
    bed = createAgentsBed();
    const member = bed.owner({ userId: "member" });
    const one = await bed.agents.create(member, agentInput({ name: "Atlas" }));
    const two = await bed.agents.create(member, agentInput({ name: "Borea" }));
    const other = await bed.agents.create(bed.owner(), agentInput({ name: "Cirrus" }));
    const cascade = createAgentsOwnerCascade(bed.agents);
    expect(await cascade.trashAll("member")).toBe(2);
    expect(bed.agents.store.list("member")).toEqual([]);
    expect(
      bed.agents
        .trash(member)
        .agents.map((entry) => entry.agentId)
        .sort(),
    ).toEqual([one.id, two.id].sort());
    expect(bed.agents.store.get("u1", other.id)).not.toBeNull();
    expect(await cascade.trashAll("member")).toBe(0);
  });

  it("a member with a running agent task is refused while it runs, and trashed once the tasks are cancelled", async () => {
    bed = createAgentsBed();
    const member = bed.owner({ userId: "member" });
    const busy = new Set<string>();
    bed.agents.setLinks({
      automation: {
        busy: (_owner, agentId) => busy.has(agentId),
        deleteTriggersOf: () => {},
        cancelQueuedOf: async () => {},
      },
    });
    const one = await bed.agents.create(member, agentInput({ name: "Atlas" }));
    const two = await bed.agents.create(member, agentInput({ name: "Borea" }));
    busy.add(two.id);
    const cascade = createAgentsOwnerCascade(bed.agents);
    await expect(cascade.trashAll("member")).rejects.toMatchObject({ code: "session_busy" });
    // The first agent went; the retry after the tasks are cancelled finishes the rest.
    busy.clear();
    expect(await cascade.trashAll("member")).toBe(1);
    expect(bed.agents.store.list("member")).toEqual([]);
    expect(
      bed.agents
        .trash(member)
        .agents.map((entry) => entry.agentId)
        .sort(),
    ).toEqual([one.id, two.id].sort());
  });
});
