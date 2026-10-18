import { describe, expect, it } from "vitest";
import { canonicalFamily, slugOf, validFamily } from "./family.ts";

describe("family names", () => {
  it("accepts letters, digits and single inner spaces", () => {
    for (const name of ["Inter", "Open Sans", "Roboto Mono", "Noto Sans 2", "a", "A".repeat(64)])
      expect(validFamily(name), name).toBe(true);
  });

  it("refuses everything else, before any network is reached", () => {
    for (const name of [
      "",
      " Inter",
      "Inter;",
      "In-ter",
      "Inter/../x",
      "Inter&family=Evil",
      "Inter\n",
      "Inter\u0000",
      "Ünter",
      "A".repeat(65),
    ])
      expect(validFamily(name), JSON.stringify(name)).toBe(false);
  });

  it("canonicalises spacing and derives a slug that is a path segment", () => {
    expect(canonicalFamily("Open   Sans ")).toBe("Open Sans");
    expect(slugOf("Open Sans")).toBe("open-sans");
    expect(slugOf("Inter")).toBe("inter");
    expect(slugOf("Noto Sans 2")).toBe("noto-sans-2");
  });
});
