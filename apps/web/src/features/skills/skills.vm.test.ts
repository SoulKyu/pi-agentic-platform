import { SKILLS_CLI, type SkillView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  defaultScope,
  groupSwitch,
  installCommand,
  safeLink,
  skillGroups,
  type ProjectRef,
} from "./skills.vm.ts";

const PROJECT: ProjectRef = { root: "/work/app", name: "app" };
const skillOf = (over: Partial<SkillView>): SkillView => ({
  name: "x",
  description: "",
  path: "/home/a/.pi/agent/skills/x/SKILL.md",
  scope: "user",
  disableModelInvocation: false,
  ...over,
});

describe("groupSwitch", () => {
  it("is on only while every row lets the model use it", () => {
    expect(groupSwitch([])).toEqual({ on: false, enabled: 0, total: 0 });
    expect(groupSwitch([{ on: true }, { on: true }])).toEqual({ on: true, enabled: 2, total: 2 });
    expect(groupSwitch([{ on: true }, { on: false }])).toEqual({ on: false, enabled: 1, total: 2 });
    expect(groupSwitch([{ on: false }])).toEqual({ on: false, enabled: 0, total: 1 });
  });
});

describe("skillGroups", () => {
  it("puts the owner's skills, the project's and every other source into three groups, in that order", () => {
    const rows = [
      skillOf({ name: "a", scope: "package" }),
      skillOf({ name: "b", scope: "project" }),
      skillOf({ name: "c", scope: "user" }),
      skillOf({ name: "d", scope: "other" }),
    ];
    expect(skillGroups(rows).map((group) => [group.id, group.rows.map((row) => row.name)])).toEqual([
      ["user", ["c"]],
      ["project", ["b"]],
      ["other", ["a", "d"]],
    ]);
  });
});

describe("install scope and command (M7R118, M7R140)", () => {
  it("defaults to the project of the session the owner came from, else to all projects", () => {
    expect(defaultScope(PROJECT)).toBe("project");
    expect(defaultScope(null)).toBe("global");
  });

  it("shows the exact command of the pinned constant, with -g only for all projects", () => {
    expect(installCommand("o/r", "global")).toBe(`npx ${SKILLS_CLI} add o/r -y --agent pi -g`);
    expect(installCommand("o/r", "project")).toBe(`npx ${SKILLS_CLI} add o/r -y --agent pi`);
    expect(installCommand("  ", "project")).toBe(`npx ${SKILLS_CLI} add o/r -y --agent pi`);
  });
});

describe("safeLink", () => {
  it("opens https links only", () => {
    expect(safeLink("https://skills.sh/o/r")).toBe("https://skills.sh/o/r");
    for (const bad of ["http://x.test", "javascript:alert(1)", "data:text/html,x", "//x.test", "", null])
      expect(safeLink(bad), String(bad)).toBeNull();
  });
});
