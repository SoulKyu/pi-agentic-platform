import { describe, expect, it } from "vitest";
import { groupSessions } from "./session-groups.ts";

const s = (id: string, cwd: string, updatedAt: number) =>
  ({ id, cwd, status: "idle", createdAt: 0, updatedAt }) as const;

describe("session groups (the tree until M4's projects)", () => {
  it("groups by working directory, newest group and newest row first", () => {
    const { groups } = groupSessions([s("a", "/w/api", 1), s("b", "/w/web", 5), s("c", "/w/api", 9)], "");
    expect(groups.map((g) => [g.label, g.sessions.map((x) => x.id)])).toEqual([
      ["api", ["c", "a"]],
      ["web", ["b"]],
    ]);
  });
  it("filters on the folder, accents and case aside", () => {
    expect(
      groupSessions([s("a", "/w/Café", 1), s("b", "/w/web", 2)], "cafe").groups.map((g) => g.label),
    ).toEqual(["Café"]);
  });
  it("shows at most 200 rows and counts the rest", () => {
    const many = Array.from({ length: 250 }, (_, i) => s(String(i), `/w/p${i % 3}`, i));
    const { groups, hidden } = groupSessions(many, "");
    expect(groups.reduce((n, g) => n + g.sessions.length, 0)).toBe(200);
    expect(hidden).toBe(50);
  });
});
