import { describe, expect, it } from "vitest";
import { laneView } from "../../testing/lane-fixtures.ts";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import { buildTree } from "./tree.vm.ts";

const NOW = 1_800_000_000_000;
const projects = new Map([
  ["p1", shellProject({ id: "p1", name: "api", root: "/w/api", position: 1, sessions: 0 })],
  ["p2", shellProject({ id: "p2", name: "web", root: "/w/web", position: 2, sessions: 0 })],
]);
const base = { projects, filter: "", projectId: null, shown: new Map<string, number>(), now: NOW };
const fixA = laneView({ id: "fix-a-1a2b", projectRoot: "/w/api", createdAt: 5 });
const fixB = laneView({ id: "fix-b-1a2b", projectRoot: "/w/api", createdAt: 9 });
const lanes = (items = [fixA, fixB], archived = 0) => ({ items, archived });
const inA = shellSession({ id: "in-a", cwd: "/p/worktrees/fix-a-1a2b/apps", projectId: "p1" });
const loose = shellSession({ id: "loose", cwd: "/w/api", projectId: "p1" });
const sibling = shellSession({ id: "sib", cwd: "/p/worktrees/fix-a-1a2b-x", projectId: "p1" });

describe("the tree with lanes", () => {
  it("groups a lane's sessions under it and keeps the others loose", () => {
    const model = buildTree({ ...base, sessions: [inA, loose, sibling], lanes: lanes() });
    const group = model.groups.find((g) => g.project?.id === "p1");
    expect(group?.sessions.map((s) => s.id).sort()).toEqual(["loose", "sib"]);
    expect(group?.lanes.map((l) => [l.lane.id, l.sessions.map((s) => s.id)])).toEqual([
      ["fix-b-1a2b", []],
      ["fix-a-1a2b", ["in-a"]],
    ]);
  });

  it("derives each lane's status from its sessions", () => {
    const running = shellSession({ ...inA, status: "running" });
    const model = buildTree({ ...base, sessions: [running], lanes: lanes() });
    expect(model.groups[0]?.lanes.map((l) => l.status)).toEqual(["idle", "working"]);
  });

  it("a project with lanes and no session still has its heading; archived lanes are not listed", () => {
    const archived = laneView({ id: "old-1a2b", projectRoot: "/w/web", state: "archived" });
    const web = laneView({ id: "web-1a2b", projectRoot: "/w/web" });
    const model = buildTree({ ...base, sessions: [], lanes: lanes([archived, web]) });
    expect(model.groups.map((g) => [g.project?.id, g.lanes.map((l) => l.lane.id)])).toEqual([
      ["p2", ["web-1a2b"]],
    ]);
  });

  it("a lane of no known project goes to Other folders", () => {
    const stray = laneView({ id: "stray-1a2b", projectRoot: "/elsewhere" });
    const model = buildTree({ ...base, sessions: [], lanes: lanes([stray]) });
    expect(model.groups[0]?.project).toBeNull();
    expect(model.groups[0]?.lanes).toHaveLength(1);
  });

  it("the current project limits the lanes too", () => {
    const web = laneView({ id: "web-1a2b", projectRoot: "/w/web" });
    const model = buildTree({ ...base, projectId: "p1", sessions: [], lanes: lanes([fixA, web]) });
    expect(model.groups.flatMap((g) => g.lanes.map((l) => l.lane.id))).toEqual(["fix-a-1a2b"]);
  });

  it("filters by title and branch, and keeps a lane whose session matches", () => {
    const named = shellSession({ ...inA, name: "needle" });
    const a = buildTree({ ...base, filter: "fix-b", sessions: [], lanes: lanes() });
    expect(a.groups[0]?.lanes.map((l) => l.lane.id)).toEqual(["fix-b-1a2b"]);
    const b = buildTree({ ...base, filter: "needle", sessions: [named], lanes: lanes() });
    expect(b.groups[0]?.lanes.map((l) => l.lane.id)).toEqual(["fix-a-1a2b"]);
  });

  it("exposes the archived count for the closing entry", () => {
    expect(buildTree({ ...base, sessions: [], lanes: lanes([], 3) }).archivedLanes).toBe(3);
    expect(buildTree({ ...base, sessions: [] }).archivedLanes).toBe(0);
  });
});
