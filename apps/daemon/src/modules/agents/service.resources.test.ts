import { afterEach, describe, expect, it } from "vitest";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);
let host = { memoryCapMb: 4096, cores: 2 };
const open = () => {
  host = { memoryCapMb: 4096, cores: 2 };
  bed = createAgentsBed({ extra: { resourceHost: () => host } });
};
const resources = (extra: object) => ({ memoryMb: 1024, cpus: 1, diskMb: 4096, ...extra });

describe("the resources check at save (RT-30)", () => {
  it("refuses a create over the memory cap or the host's cores", async () => {
    open();
    expect(
      await refusalOf(() =>
        bed.agents.create(bed.owner(), agentInput({ resources: resources({ memoryMb: 4096 }) })),
      ),
    ).toBe("bad_request");
    expect(
      await refusalOf(() =>
        bed.agents.create(bed.owner(), agentInput({ resources: resources({ cpus: 3 }) })),
      ),
    ).toBe("bad_request");
  });
  it("refuses an update that shrinks the disk, accepts one that grows it", async () => {
    open();
    const view = await bed.agents.create(bed.owner(), agentInput());
    const update = (diskMb: number) =>
      bed.agents.update(bed.owner(), {
        agentId: view.id,
        baseRevision: view.revision,
        input: agentInput({ resources: resources({ diskMb }) }),
      });
    expect(await refusalOf(() => update(2048))).toBe("bad_request");
    expect(await refusalOf(() => update(8192))).toBe("no error");
  });
  it("checks nothing when the host is not described (no VM runtime)", async () => {
    bed = createAgentsBed();
    expect(
      await refusalOf(() =>
        bed.agents.create(bed.owner(), agentInput({ resources: resources({ cpus: 64 }) })),
      ),
    ).toBe("no error");
  });
  it("does not check a save that leaves resources as they are: a rename survives a dropped cap (AVM-E17)", async () => {
    open();
    const view = await bed.agents.create(
      bed.owner(),
      agentInput({ resources: resources({ memoryMb: 2048 }) }),
    );
    host = { memoryCapMb: 1024, cores: 1 };
    const input = agentInput({ name: "Renamed", resources: resources({ memoryMb: 2048 }) });
    expect(
      await refusalOf(() =>
        bed.agents.update(bed.owner(), { agentId: view.id, baseRevision: view.revision, input }),
      ),
    ).toBe("no error");
  });
});
