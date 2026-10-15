import { describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { IMPLEMENTED, lanesFanoutRpc } from "./rpc-fanout.ts";

describe("the fan-out handlers", () => {
  it("declare the two methods they serve and hand the transport's caller, never a param, to the service", async () => {
    expect([...IMPLEMENTED].sort()).toEqual(["lanes.closeLosers", "lanes.compare"]);
    const compare = vi.fn(async () => ({ columns: [] }));
    const closeLosers = vi.fn(async () => ({ archived: [], refused: [] }));
    const rpc = lanesFanoutRpc({ compare, closeLosers });
    const caller = testCaller();
    const ctx = { caller } as never;
    await rpc["lanes.compare"]({ fanoutId: "1111111111111111" }, ctx);
    await rpc["lanes.closeLosers"]({ fanoutId: "1111111111111111", winner: "a-0001" }, ctx);
    expect(compare).toHaveBeenCalledWith(caller, { fanoutId: "1111111111111111" });
    expect(closeLosers).toHaveBeenCalledWith(caller, { fanoutId: "1111111111111111", winner: "a-0001" });
  });
});
