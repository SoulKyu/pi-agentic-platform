import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/index.ts";
import { EMPTY_LANES } from "../../stores/lane-reducer.ts";
import { itemTitle } from "./item-title.ts";

const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const none = new Map<string, never>();

describe("the agent tab's title (M11R109)", () => {
  it("is the agent's name", () => {
    const names = new Map([["agent:atlas-1a2b", "Atlas"]]);
    expect(itemTitle({ kind: "agent", id: "atlas-1a2b" }, none, {}, t, EMPTY_LANES, names)).toBe("Atlas");
  });

  it("says Agent while the stream has not named it", () => {
    expect(itemTitle({ kind: "agent", id: "atlas-1a2b" }, none, {}, t)).toBe("Agent");
  });

  it("does not take a trigger's name for an agent's", () => {
    const names = new Map([["atlas-1a2b", "Nightly report"]]);
    expect(itemTitle({ kind: "agent", id: "atlas-1a2b" }, none, {}, t, EMPTY_LANES, names)).toBe("Agent");
  });
});
