import { describe, expect, it } from "vitest";
import { PROJECT_REPO, PROJECT_URL, sourceUrl } from "./source.ts";

describe("sourceUrl (AGPL section 13)", () => {
  it("points at the tag of a release version", () => {
    expect(sourceUrl("1.2.3")).toBe(`https://github.com/${PROJECT_REPO}/tree/v1.2.3`);
  });

  it("points at the repository root for a dev, pre-release, unreleased or unknown version", () => {
    for (const version of [
      null,
      "",
      "0.0.0",
      "1.2.3-rc.1",
      "1.2.3+build5",
      "1.2",
      "v1.2.3",
      "1.2.3/../x",
      "dev",
    ]) {
      expect(sourceUrl(version)).toBe(PROJECT_URL);
    }
  });

  it("builds every URL from the one repository constant", () => {
    expect(PROJECT_URL).toBe(`https://github.com/${PROJECT_REPO}`);
    expect(sourceUrl("2.0.0").startsWith(`${PROJECT_URL}/`)).toBe(true);
  });
});
