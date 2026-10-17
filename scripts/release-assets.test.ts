import { describe, expect, it } from "vitest";
import { printedCommands, assetTag } from "./release-assets.ts";

describe("release assets", () => {
  it("defaults the stable tag to v<root version> and the next tag to next", () => {
    expect(assetTag("stable", undefined, "1.2.3")).toBe("v1.2.3");
    expect(assetTag("next", undefined, "1.2.3")).toBe("next");
    expect(() => assetTag("stable", "1.2.3", "1.2.3")).toThrow(/tag/);
    expect(() => assetTag("next", "v1.2.3", "1.2.3")).toThrow(/tag/);
  });

  it("refuses a stable tag that is not v<root version>", () => {
    expect(assetTag("stable", "v1.2.3", "1.2.3")).toBe("v1.2.3");
    expect(() => assetTag("stable", "v9.9.9", "1.2.3")).toThrow(/tag/);
    expect(() => assetTag("stable", "v1.2.4", "1.2.3")).toThrow(/tag/);
  });

  it("prints gh commands for a stable and a next release without running anything", () => {
    const stable = printedCommands("stable", "v1.2.3", "SoulKyu/pi-agentic-platform", "/tmp/rel");
    expect(stable.join("\n")).toContain("gh release create v1.2.3");
    expect(stable.join("\n")).toContain("gh release upload v1.2.3");
    expect(stable.join("\n")).toContain("--clobber");
    const next = printedCommands("next", "next", "SoulKyu/pi-agentic-platform", "/tmp/rel");
    expect(next.join("\n")).toContain("--prerelease");
  });
});
