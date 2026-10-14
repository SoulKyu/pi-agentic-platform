import { describe, expect, it } from "vitest";
import { sessionSnapshot } from "../testing/session-snapshot.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const loadout = (preset: string) => ({
  model: null,
  thinkingLevel: "off",
  levels: ["off"],
  preset,
  tools: [],
  toolsTruncated: false,
});

describe("reduceSession (stored tool preset, MC37)", () => {
  it("is unknown before a snapshot and takes the snapshot's stored preset, cold or not", () => {
    expect(EMPTY_VIEW.toolPreset).toBeNull();
    expect(
      reduceSession(EMPTY_VIEW, sessionSnapshot({ status: "cold", toolPreset: "read-only" })).toolPreset,
    ).toBe("read-only");
  });

  it("is configured from an older daemon that sends none", () => {
    expect(reduceSession(EMPTY_VIEW, sessionSnapshot()).toolPreset).toBe("configured");
  });

  it("follows a loadout the worker reports and keeps it when the session goes cold", () => {
    let view = reduceSession(EMPTY_VIEW, sessionSnapshot({ toolPreset: "default" }));
    view = reduceSession(view, { kind: "loadout", loadout: loadout("full") });
    expect(view.toolPreset).toBe("full");
    view = reduceSession(view, { kind: "status", status: "cold" });
    expect(view.loadout).toBeNull();
    expect(view.toolPreset).toBe("full");
  });
});
