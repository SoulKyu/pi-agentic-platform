import { describe, expect, it, vi } from "vitest";
import { createImageEntries, imageEntriesOf } from "./pick-map.ts";

/*
 * Mutants (RT-43), run for real: `imageEntriesOf` keeps an unmatched pick as it is -> "reports a pick the image did not write" fails;
 * `toImage` maps null to a list -> "null stays null"; an unmatched pick is not logged -> "logs ..." fails.
 */
const WRITTEN = [
  { source: "npm:a", written: "npm:a@1.0.0" },
  { source: "../b", written: "local/b" },
];

describe("imageEntriesOf", () => {
  it("maps each pick to the entry the image wrote, in the order picked", () => {
    expect(imageEntriesOf(["../b", "npm:a"], WRITTEN)).toEqual({
      entries: ["local/b", "npm:a@1.0.0"],
      missing: [],
    });
  });
  it("reports a pick the image did not write", () => {
    expect(imageEntriesOf(["npm:a", "npm:zzz"], WRITTEN)).toEqual({
      entries: ["npm:a@1.0.0"],
      missing: ["npm:zzz"],
    });
  });
});

describe("createImageEntries", () => {
  it("maps through the agent's recorded build, and keeps null as null", () => {
    const warn = vi.fn();
    const entries = createImageEntries({ warn });
    entries.record("scout-0001", WRITTEN);
    expect(entries.toImage("scout-0001", ["npm:a"])).toEqual(["npm:a@1.0.0"]);
    expect(entries.toImage("scout-0001", null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
  it("logs a pick the build did not write, and a launch with no recorded build", () => {
    const warn = vi.fn();
    const entries = createImageEntries({ warn });
    entries.record("scout-0001", WRITTEN);
    expect(entries.toImage("scout-0001", ["npm:zzz"])).toEqual([]);
    expect(warn).toHaveBeenCalledWith("agent_pick_not_in_image", { agentId: "scout-0001", count: 1 });
    expect(entries.toImage("other-0002", ["npm:a"])).toEqual(["npm:a"]);
    expect(warn).toHaveBeenCalledWith("agent_pick_image_unknown", { agentId: "other-0002", picks: 1 });
    entries.forget("scout-0001");
    expect(entries.toImage("scout-0001", ["npm:a"])).toEqual(["npm:a"]);
  });
});
