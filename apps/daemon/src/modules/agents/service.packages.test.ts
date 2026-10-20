import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

/*
 * Mutants (RT-43), run for real:
 * - `checkAgentSave` skips `checkPackages` on create -> "refuses an unknown id at create" fails.
 * - `checkAgentSave` checks on every update (drops the `changed` guard) -> "does not check a save that leaves the picks
 *   alone" fails (a rename would fail because a package was removed since).
 * - `checkAgentSave` checks when the picks are `null` -> "null means every package" fails.
 */
let bed: AgentsBed;
afterEach(() => bed.dispose());
const { refusalOf } = bedHelpers(() => bed);
const ID = "a".repeat(32);
const OTHER = "b".repeat(32);
let unknown = false;
const checkPackages = vi.fn(async (_ids: readonly string[]) => {
  if (unknown) throw new PapError("not_found");
});
const open = () => {
  unknown = false;
  checkPackages.mockClear();
  bed = createAgentsBed({ extra: { checkPackages } });
};

describe("the package picks at save (AVM-E33)", () => {
  it("accepts ids the check holds and stores them as sent", async () => {
    open();
    const view = await bed.agents.create(bed.owner(), agentInput({ packages: [ID] }));
    expect(checkPackages).toHaveBeenCalledWith([ID]);
    expect(view.input?.packages).toEqual([ID]);
  });

  it("refuses an unknown id at create, with the typed error, and saves nothing", async () => {
    open();
    unknown = true;
    expect(await refusalOf(() => bed.agents.create(bed.owner(), agentInput({ packages: [ID] })))).toBe(
      "not_found",
    );
    expect(bed.agents.list(bed.owner()).agents).toEqual([]);
  });

  it("refuses an unknown id at update, and leaves the agent as it was", async () => {
    open();
    const view = await bed.agents.create(bed.owner(), agentInput({ packages: [ID] }));
    unknown = true;
    const update = (packages: string[]) =>
      bed.agents.update(bed.owner(), {
        agentId: view.id,
        baseRevision: view.revision,
        input: agentInput({ packages }),
      });
    expect(await refusalOf(() => update([OTHER]))).toBe("not_found");
    expect(bed.agents.view(bed.owner(), view.id).revision).toBe(view.revision);
  });

  it("does not check a save that leaves the picks alone: a rename survives a removed package", async () => {
    open();
    const view = await bed.agents.create(bed.owner(), agentInput({ packages: [ID] }));
    checkPackages.mockClear();
    unknown = true;
    const input = agentInput({ name: "Renamed", packages: [ID] });
    expect(
      await refusalOf(() =>
        bed.agents.update(bed.owner(), { agentId: view.id, baseRevision: view.revision, input }),
      ),
    ).toBe("no error");
    expect(checkPackages).not.toHaveBeenCalled();
  });

  it("null means every package and is never checked", async () => {
    open();
    await bed.agents.create(bed.owner(), agentInput({ packages: null }));
    expect(checkPackages).not.toHaveBeenCalled();
  });
});
