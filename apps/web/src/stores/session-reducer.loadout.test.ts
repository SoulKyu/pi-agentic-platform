import { describe, expect, it } from "vitest";
import { sessionSnapshot } from "../testing/session-snapshot.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const loadout = {
  model: { provider: "scripted", id: "plain", name: "Plain", reasoning: false },
  thinkingLevel: "off",
  levels: ["off"],
  preset: "configured",
  tools: ["read"],
  toolsTruncated: false,
};

describe("reduceSession (loadout, M7R44)", () => {
  it("starts without a loadout", () => {
    expect(EMPTY_VIEW.loadout).toBeNull();
  });

  it("takes the loadout of a snapshot, and a snapshot with null clears it", () => {
    let view = reduceSession(EMPTY_VIEW, sessionSnapshot({ loadout }));
    expect(view.loadout).toEqual(loadout);
    view = reduceSession(view, sessionSnapshot({ loadout: null }));
    expect(view.loadout).toBeNull();
    // An older daemon sends none at all.
    view = reduceSession(reduceSession(EMPTY_VIEW, sessionSnapshot({ loadout })), sessionSnapshot());
    expect(view.loadout).toBeNull();
  });

  it("clears the loadout when the session goes cold: its worker is gone", () => {
    const view = reduceSession(EMPTY_VIEW, sessionSnapshot({ loadout }));
    expect(reduceSession(view, { kind: "status", status: "cold" }).loadout).toBeNull();
    expect(reduceSession(view, { kind: "status", status: "running" }).loadout).toEqual(loadout);
  });

  it("replaces the loadout on a loadout event", () => {
    let view = reduceSession(EMPTY_VIEW, sessionSnapshot({ loadout }));
    const next = { ...loadout, thinkingLevel: "high", levels: ["off", "low", "high"] };
    view = reduceSession(view, { kind: "loadout", loadout: next });
    expect(view.loadout).toEqual(next);
  });

  it("drops a loadout event the contract cannot read and keeps the last one", () => {
    const view = reduceSession(EMPTY_VIEW, sessionSnapshot({ loadout }));
    expect(reduceSession(view, { kind: "loadout", loadout: { ...loadout, levels: "all" } }).loadout).toEqual(
      loadout,
    );
  });
});
