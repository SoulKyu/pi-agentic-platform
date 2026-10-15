import { describe, expect, it } from "vitest";
import { laneView } from "../../testing/lane-fixtures.ts";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import { projectForNewLane } from "./new-lane-project.ts";

const a = shellProject({ id: "a", root: "/w/a" });
const b = shellProject({ id: "b", root: "/w/b" });
const facts = {
  switcherId: null as string | null,
  item: null as Parameters<typeof projectForNewLane>[0]["item"],
  projects: [a, b],
  sessions: new Map([["s1", shellSession({ id: "s1", projectId: "b" })]]),
  lanes: new Map([["l-1a2b", laneView({ id: "l-1a2b", projectRoot: "/w/a" })]]),
};

describe("the project a new lane opens for (M9R95)", () => {
  it("is the switcher's, even when the active tab belongs to another", () => {
    expect(projectForNewLane({ ...facts, switcherId: "a", item: { kind: "session", id: "s1" } })).toBe("a");
  });

  it("else the active tab's: a session's project, a lane's root, a folder it shows", () => {
    expect(projectForNewLane({ ...facts, item: { kind: "session", id: "s1" } })).toBe("b");
    expect(projectForNewLane({ ...facts, item: { kind: "lane", id: "l-1a2b" } })).toBe("a");
    expect(projectForNewLane({ ...facts, item: { kind: "files", root: "/w/b" } })).toBe("b");
    expect(projectForNewLane({ ...facts, item: { kind: "changes", root: "/w/a" } })).toBe("a");
  });

  it("else none: the dialog asks", () => {
    expect(projectForNewLane(facts)).toBeNull();
    expect(projectForNewLane({ ...facts, item: { kind: "home" } })).toBeNull();
    expect(projectForNewLane({ ...facts, item: { kind: "session", id: "unknown" } })).toBeNull();
    expect(projectForNewLane({ ...facts, switcherId: "gone" })).toBeNull();
  });
});
