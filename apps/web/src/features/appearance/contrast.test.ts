import { describe, expect, it } from "vitest";
import { contrastRatio, ensureContrast, mix } from "./contrast.ts";

describe("WCAG contrast", () => {
  it("measures the known pairs", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#fb923c", "#faf9f6")).toBeCloseTo(2.15, 2); // R120: day focus ring
    expect(contrastRatio("#c2410c", "#faf9f6")).toBeCloseTo(4.92, 2);
  });

  it("composites a translucent background over its backdrop", () => {
    expect(contrastRatio("#ec4899", "#ec48991a", "#1a1724")).toBeCloseTo(4.48, 1); // R120: night approval title
  });

  it("mixes in sRGB and moves a colour toward a target until it passes", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    const fixed = ensureContrast("#fb923c", "#faf9f6", 4.5, "#1c1917");
    expect(contrastRatio(fixed, "#faf9f6")).toBeGreaterThanOrEqual(4.5);
  });
});
