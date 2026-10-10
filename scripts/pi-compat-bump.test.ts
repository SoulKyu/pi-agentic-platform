import { describe, expect, it } from "vitest";
import { bumpCatalog } from "./pi-compat-bump.ts";

describe("bumpCatalog", () => {
  it("sets every @earendil-works catalog entry to latest and leaves the rest alone", () => {
    const input = [
      "packages:",
      "  - apps/*",
      "catalog:",
      '  "@earendil-works/pi-coding-agent": 1.1.0',
      '  "@earendil-works/pi-ai": 1.1.0',
      '  "zod": 4.1.0',
      "minimumReleaseAge: 4320",
    ].join("\n");
    expect(bumpCatalog(input)).toBe(
      [
        "packages:",
        "  - apps/*",
        "catalog:",
        '  "@earendil-works/pi-coding-agent": latest',
        '  "@earendil-works/pi-ai": latest',
        '  "zod": 4.1.0',
        "minimumReleaseAge: 4320",
      ].join("\n"),
    );
  });
});
