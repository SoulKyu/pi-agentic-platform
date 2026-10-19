import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrompts } from "./prompts.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);

// R16 (RT-08): the chips of a VM agent are not read from the host home.
async function world(vm: boolean) {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  const prompts = join(bed.papHome, "agents", id, "prompts");
  mkdirSync(prompts, { recursive: true, mode: 0o700 });
  writeFileSync(join(prompts, "daily.md"), "text");
  return {
    id,
    service: createPrompts({ store: bed.agents.store, papHome: bed.papHome, runsInVm: () => vm }),
  };
}

describe("agents.prompts of a VM agent (R16)", () => {
  it("lists nothing though the host home has chips", async () => {
    const { id, service } = await world(true);
    expect(service.list(bed.owner(), id)).toEqual({ names: [] });
  });
  it("lists nothing, not invalid_cwd, when the host home is gone", async () => {
    const { id, service } = await world(true);
    rmSync(join(bed.papHome, "agents", id), { recursive: true });
    expect(service.list(bed.owner(), id)).toEqual({ names: [] });
  });
  it("reads none either", async () => {
    const { id, service } = await world(true);
    expect(await refusalOf(() => service.read(bed.owner(), id, "daily.md"))).toBe("not_found");
  });
  it("a host agent still lists its chips", async () => {
    const { id, service } = await world(false);
    expect(service.list(bed.owner(), id)).toEqual({ names: ["daily.md"] });
  });
});
