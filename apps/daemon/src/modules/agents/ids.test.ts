import { AgentId } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { agentIdOf, randomAgentHex } from "./ids.ts";
import type { AgentVmLink } from "./links.ts";
import { createTrashPurge } from "./trash-purge.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const sequence = (...values: string[]) => {
  let next = 0;
  return () => values[Math.min(next++, values.length - 1)] ?? "00000000";
};

describe("agent ids (RT-19)", () => {
  it("a new id ends in 8 hex digits and still fits the vault scope name for the longest name", () => {
    bed = createAgentsBed();
    expect(randomAgentHex()).toMatch(/^[0-9a-f]{8}$/);
    const id = agentIdOf("a".repeat(100), "0123abcd");
    expect(id).not.toBeNull();
    expect(`agent-${id}`.length).toBeLessThanOrEqual(54);
    expect(id?.length).toBeLessThanOrEqual(48);
    expect(AgentId.safeParse(id).success).toBe(true);
    expect(AgentId.safeParse("atlas-0001").success).toBe(true);
    expect(AgentId.safeParse("atlas-00001").success).toBe(false);
  });

  it("an agent id never lands on a trashed agent's id, whoever owned it", async () => {
    bed = createAgentsBed({ extra: { randomHex: sequence("aaaaaaaa", "aaaaaaaa", "bbbbbbbb") } });
    const first = await bed.agents.create(bed.owner(), agentInput({ name: "Atlas" }));
    expect(first.id).toBe("atlas-aaaaaaaa");
    await bed.agents.remove(bed.owner(), first.id);
    expect(bed.agents.store.exists(first.id)).toBe(true);
    const second = await bed.agents.create(bed.owner({ userId: "u2" }), agentInput({ name: "Atlas" }));
    expect(second.id).toBe("atlas-bbbbbbbb");
    expect(bed.agents.trash(bed.owner()).agents.map((entry) => entry.agentId)).toEqual([first.id]);
  });

  it("a create that can only meet trashed ids is a conflict, never a reuse", async () => {
    bed = createAgentsBed({ extra: { randomHex: sequence("aaaaaaaa") } });
    const first = await bed.agents.create(bed.owner(), agentInput({ name: "Atlas" }));
    await bed.agents.remove(bed.owner(), first.id);
    await expect(
      bed.agents.create(bed.owner({ userId: "u2" }), agentInput({ name: "Atlas" })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("a member's purgeTrash never touches another user's trashed disk", async () => {
    const purged: string[] = [];
    const vm: AgentVmLink = {
      require: async () => {},
      stop: async () => {},
      dispose: async () => {},
      purge: async (id) => void purged.push(id),
      resume: () => {},
    };
    bed = createAgentsBed({ extra: { vm } });
    const mine = await bed.agents.create(bed.owner(), agentInput({ name: "Atlas" }));
    await bed.agents.remove(bed.owner(), mine.id);
    const purge = createTrashPurge({
      store: bed.agents.store,
      links: bed.agents.links,
      clock: bed.clock,
      audit: bed.audit,
      logger: silentLogger,
      requireStepUp: () => {},
    });
    await expect(purge.purge(bed.owner({ userId: "member" }), mine.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(purged).toEqual([]);
    expect(bed.agents.trash(bed.owner()).agents).toHaveLength(1);
  });
});
