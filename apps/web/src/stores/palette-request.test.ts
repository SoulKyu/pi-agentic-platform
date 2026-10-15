import { beforeEach, describe, expect, it } from "vitest";
import { usePaletteRequest } from "./palette-request.ts";

beforeEach(() => usePaletteRequest.setState({ search: null }));

describe("the palette request (decision 85)", () => {
  it("is read once: a later plain opening never sees a stale search", () => {
    usePaletteRequest.getState().askSearch("p1");
    expect(usePaletteRequest.getState().take()).toEqual({ projectId: "p1" });
    expect(usePaletteRequest.getState().take()).toBeNull();
    usePaletteRequest.getState().askSearch(null);
    expect(usePaletteRequest.getState().take()).toEqual({ projectId: null });
  });
});
