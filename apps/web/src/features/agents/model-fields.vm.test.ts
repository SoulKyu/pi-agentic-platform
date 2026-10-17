import { describe, expect, it } from "vitest";
import { levelsFor } from "./model-fields.vm.ts";

describe("levelsFor", () => {
  it("offers every level to a model that reasons, and to a model nobody listed", () => {
    expect(levelsFor({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(levelsFor(undefined)).toHaveLength(7);
  });

  it("offers only off to a model without reasoning (M7R45)", () => {
    expect(levelsFor({ reasoning: false })).toEqual(["off"]);
  });
});
