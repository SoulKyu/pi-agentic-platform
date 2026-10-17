import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentsBed, type AgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

function insertRow(id: string, name: string, profile: string): void {
  bed.db.run(
    `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
     VALUES ($id, 'u1', $name, lower($name), $profile, 1, 1)`,
    { id, name, profile },
  );
}

describe("agents.list", () => {
  it("skips a row whose id is no longer an agent id, with a log, and lists the others", () => {
    bed = createAgentsBed();
    insertRow("Hand Edited!", "Edited", "{}");
    insertRow("atlas-0000", "Atlas", JSON.stringify(AgentInput.parse({ name: "Atlas" })));
    const listed = bed.agents.list(bed.unconfirmed());
    expect(listed.agents.map((agent) => agent.id)).toEqual(["atlas-0000"]);
    expect(listed.truncated).toBe(false);
    expect(bed.logs.filter((line) => line.msg === "agent_row_unlistable")).toHaveLength(1);
  });

  it("stops at the page size and says so (truncated)", () => {
    bed = createAgentsBed();
    const role = "☃".repeat(8000);
    const allowHosts = Array.from({ length: 100 }, (_, n) => `host${n}${"a".repeat(50)}.example.com`);
    for (let n = 0; n < 32; n += 1) {
      const name = `Big${n}`;
      insertRow(
        `big-${n.toString(16).padStart(4, "0")}`,
        name,
        JSON.stringify(AgentInput.parse({ name, role, allowHosts })),
      );
    }
    const listed = bed.agents.list(bed.unconfirmed());
    expect(listed.truncated).toBe(true);
    expect(listed.agents.length).toBeGreaterThan(0);
    expect(listed.agents.length).toBeLessThan(32);
    expect(sizeOf(listed)).toBeLessThanOrEqual(PAGE_BYTES);
    expect(listed.agents[0]?.id).toBe("big-0000");
  });
});

describe("setLinks", () => {
  it("keeps a bound link when a later call passes the same key as undefined", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.owner(), { ...AgentInput.parse({ name: "Atlas" }) });
    const drop = vi.fn();
    bed.agents.setLinks({ vault: { drop } });
    bed.agents.setLinks({ vault: undefined });
    expect(bed.agents.links().vault).toBeDefined();
    await bed.agents.remove(bed.owner(), "atlas-0000");
    expect(drop).toHaveBeenCalledTimes(1);
  });
});
