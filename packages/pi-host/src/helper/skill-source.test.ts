import { describe, expect, it } from "vitest";
import { SKILLS_CLI } from "@pap/contracts";
import { skillInstallArgs, skillSource } from "./skill-source.ts";

describe("skillSource (M7R112)", () => {
  it("accepts owner/repo, owner/repo@skill and a GitHub URL", () => {
    for (const ok of [
      "vercel-labs/agent-skills",
      "owner/repo@skill",
      "https://github.com/o/r/tree/main/skills/x",
      "https://github.com/o/r",
    ])
      expect(skillSource(ok)).toBe(ok);
    expect(skillSource("  o/r  ")).toBe("o/r");
  });

  it("refuses an option, a path, another host, extra words and an empty string", () => {
    for (const bad of [
      "--registry=evil",
      "-g",
      "../x",
      "https://evil.test/o/r",
      "http://github.com/o/r",
      "o/r --x",
      "o/r;rm",
      "o/r\n-g",
      "",
      "   ",
      "/abs/path",
      "o/-r",
      "-o/r",
    ])
      expect(skillSource(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("the pinned CLI and its arguments", () => {
  it("pins the skills release verified at implementation (>= 3 days old, vercel-labs/skills)", () => {
    expect(SKILLS_CLI).toBe("skills@1.7.2");
  });

  it("builds the exact argument arrays", () => {
    expect(skillInstallArgs("o/r", "global")).toEqual([
      "--yes",
      SKILLS_CLI,
      "add",
      "o/r",
      "-y",
      "--agent",
      "pi",
      "-g",
    ]);
    expect(skillInstallArgs("o/r@s", "project")).toEqual([
      "--yes",
      SKILLS_CLI,
      "add",
      "o/r@s",
      "-y",
      "--agent",
      "pi",
    ]);
  });
});
