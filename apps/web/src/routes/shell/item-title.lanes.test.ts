import { LANE_STATUSES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/index.ts";
import { EMPTY_LANES } from "../../stores/lane-reducer.ts";
import { fanoutView, laneView } from "../../testing/lane-fixtures.ts";
import { itemTitle } from "./item-title.ts";

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate("en", key, vars);
const lanes = {
  lanes: new Map([["fix-a-1a2b", laneView({ id: "fix-a-1a2b", branch: "pi/fix-a" })]]),
  fanouts: new Map([
    ["0123456789abcdef", fanoutView({ id: "0123456789abcdef", laneIds: ["a-1a2b", "b-1a2b", "c-1a2b"] })],
  ]),
};

describe("itemTitle for lanes", () => {
  it("a lane tab reads its branch", () => {
    expect(itemTitle({ kind: "lane", id: "fix-a-1a2b" }, new Map(), {}, t, lanes)).toBe("pi/fix-a");
  });
  it("a lane the store lacks keeps a word, not the id", () => {
    expect(itemTitle({ kind: "lane", id: "gone-1a2b" }, new Map(), {}, t, EMPTY_LANES)).toBe("Lane");
  });
  it("a compare tab counts its lanes", () => {
    expect(itemTitle({ kind: "compare", id: "0123456789abcdef" }, new Map(), {}, t, lanes)).toBe(
      "Compare · 3 lanes",
    );
  });
  it("every status has a word in both languages", () => {
    for (const status of LANE_STATUSES)
      for (const locale of ["en", "fr"] as const)
        expect(translate(locale, `shell.lane.status.${status}`)).not.toMatch(/^shell\./);
  });
});
