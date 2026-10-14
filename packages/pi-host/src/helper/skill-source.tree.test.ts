import { describe, expect, it } from "vitest";
import { skillSource } from "./skill-source.ts";

describe("a GitHub /tree/ subpath has no dot segment (MC55, T24 M4; MC54 for plugins)", () => {
  it("refuses . and .. segments anywhere in the subpath", () => {
    for (const bad of [
      "https://github.com/o/r/tree/main/../../..",
      "https://github.com/o/r/tree/main/./x",
      "https://github.com/o/r/tree/../x",
      "https://github.com/o/r/tree/main/x/..",
      "https://github.com/o/r/tree/main/x/.",
    ])
      expect(skillSource(bad), bad).toBeNull();
  });

  it("still accepts dotted names that are not dot segments", () => {
    for (const ok of [
      "https://github.com/o/r/tree/main/skills/x",
      "https://github.com/o/r/tree/v1.2.3/.agents/skills/a..b",
      "https://github.com/o/r/tree/main/.claude/skills",
    ])
      expect(skillSource(ok), ok).toBe(ok);
  });
});
