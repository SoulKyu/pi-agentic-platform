import { SessionLoadout } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { fitSnapshot, sizeOf, SNAPSHOT_BYTES } from "./snapshot.ts";

const loadout: SessionLoadout = {
  model: { provider: "faux", id: "plain", name: "Plain", reasoning: false },
  thinkingLevel: "off",
  levels: ["off"],
  preset: "configured",
  tools: ["read"],
  toolsTruncated: false,
};

describe("fitSnapshot and the loadout", () => {
  it("carries the loadout it is given and defaults to null", () => {
    expect(fitSnapshot({ status: "idle", rows: [], dialogs: [], loadout }).loadout).toEqual(loadout);
    expect(fitSnapshot({ status: "idle", rows: [], dialogs: [] }).loadout).toBeNull();
    expect(fitSnapshot({ status: "idle", rows: [], dialogs: [], loadout: null }).loadout).toBeNull();
  });

  it("holds the largest loadout the contract allows inside the frame, rows included", () => {
    const biggest: SessionLoadout = {
      ...loadout,
      tools: Array.from({ length: 256 }, () => "t".repeat(256)),
      toolsTruncated: true,
    };
    expect(SessionLoadout.safeParse(biggest).success).toBe(true);
    const rows = Array.from({ length: 75 }, (_, i) => ({
      entryId: `e${i}`,
      message: { role: "user", content: "x".repeat(2000) },
    }));
    const snapshot = fitSnapshot({ status: "idle", rows, dialogs: [], loadout: biggest });
    expect(snapshot.loadout).toEqual(biggest);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
  });
});
