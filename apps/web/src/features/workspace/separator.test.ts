import { describe, expect, it } from "vitest";
import { clampRatio, ratioAfterKey, ratioBounds, ratioFromPointer } from "./separator.ts";

describe("pane separator (DESIGN.md §8: 320 px minimum)", () => {
  it("bounds the ratio by the pixel minimum and the 15/85 % limits", () => {
    expect(ratioBounds(1000, 320)).toEqual([0.32, 0.68]);
    expect(ratioBounds(4000, 320)).toEqual([0.15, 0.85]);
    expect(ratioBounds(600, 320)).toEqual([0.5, 0.5]);
    expect(clampRatio(0.1, 1000, 320)).toBe(0.32);
  });
  it("moves 8 px per arrow, 40 px with Shift, resets with Home", () => {
    expect(ratioAfterKey(0.5, "ArrowLeft", false, 1000, 320)).toBeCloseTo(0.492, 6);
    expect(ratioAfterKey(0.5, "ArrowRight", true, 1000, 320)).toBeCloseTo(0.54, 6);
    expect(ratioAfterKey(0.33, "ArrowLeft", true, 1000, 320)).toBe(0.32);
    expect(ratioAfterKey(0.6, "Home", false, 1000, 320)).toBe(0.5);
    expect(ratioAfterKey(0.6, "Enter", false, 1000, 320)).toBeNull();
  });
  it("turns a pointer position into a clamped ratio", () => {
    expect(ratioFromPointer(600, 100, 1000, 320)).toBe(0.5);
    expect(ratioFromPointer(150, 100, 1000, 320)).toBe(0.32);
  });
});
