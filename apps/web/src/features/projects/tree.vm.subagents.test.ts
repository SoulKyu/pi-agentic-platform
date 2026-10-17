import { describe, expect, it } from "vitest";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import { buildTree } from "./tree.vm.ts";

const NOW = 1_800_000_000_000;
const projects = new Map([["p1", shellProject({ id: "p1", name: "api", sessions: 3 })]]);
const base = { projects, filter: "", projectId: null, shown: new Map<string, number>(), now: NOW };
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((s) => s.id);

describe("subagents in the ⌘B tree (M11R153)", () => {
  it("files a child under its parent, not among the project's sessions", () => {
    const model = buildTree({
      ...base,
      sessions: [
        shellSession({ id: "p", projectId: "p1", updatedAt: 5 }),
        shellSession({ id: "c1", projectId: "p1", updatedAt: 9, parentId: "p" }),
        shellSession({ id: "c2", projectId: "p1", updatedAt: 7, parentId: "p" }),
        shellSession({ id: "other", projectId: "p1", updatedAt: 1 }),
      ],
    });
    expect(ids(model.groups[0]?.sessions ?? [])).toEqual(["p", "other"]);
    expect(ids(model.children.get("p") ?? [])).toEqual(["c1", "c2"]);
    expect(model.children.has("other")).toBe(false);
  });

  it("counts a child toward neither the cap nor the hidden rows of its project", () => {
    const sessions = [
      shellSession({ id: "p", projectId: "p1" }),
      ...Array.from({ length: 30 }, (_, i) => shellSession({ id: `c${i}`, projectId: "p1", parentId: "p" })),
    ];
    const model = buildTree({ ...base, sessions });
    expect([model.groups[0]?.sessions.length, model.groups[0]?.hidden]).toEqual([1, 0]);
  });

  it("files a child of a pinned, snoozed or settled parent under it too", () => {
    const model = buildTree({
      ...base,
      sessions: [
        shellSession({ id: "pin", projectId: "p1", pinRank: 1 }),
        shellSession({ id: "zz", projectId: "p1", snoozedUntil: NOW + 5_000 }),
        shellSession({ id: "st", projectId: "p1", settledAt: 3 }),
        shellSession({ id: "k1", projectId: "p1", parentId: "pin" }),
        shellSession({ id: "k2", projectId: "p1", parentId: "zz" }),
        shellSession({ id: "k3", projectId: "p1", parentId: "st" }),
      ],
    });
    expect([ids(model.pinned), ids(model.snoozed), ids(model.settled)]).toEqual([["pin"], ["zz"], ["st"]]);
    expect([...model.children].map(([parent, list]) => [parent, ids(list)])).toEqual([
      ["pin", ["k1"]],
      ["zz", ["k2"]],
      ["st", ["k3"]],
    ]);
  });

  it("leaves a child whose parent the browser does not hold in the list, so it can still be found", () => {
    const model = buildTree({
      ...base,
      sessions: [shellSession({ id: "orphan", projectId: "p1", parentId: "gone" })],
    });
    expect(ids(model.groups[0]?.sessions ?? [])).toEqual(["orphan"]);
    expect(model.children.size).toBe(0);
  });

  it("files one level only: a subagent of a subagent stays a row of its own", () => {
    const model = buildTree({
      ...base,
      sessions: [
        shellSession({ id: "p", projectId: "p1", updatedAt: 9 }),
        shellSession({ id: "c", projectId: "p1", parentId: "p", updatedAt: 8 }),
        shellSession({ id: "gc", projectId: "p1", parentId: "c", updatedAt: 7 }),
      ],
    });
    expect(ids(model.groups[0]?.sessions ?? [])).toEqual(["p", "gc"]);
    expect([...model.children.keys()]).toEqual(["p"]);
  });

  it("leaves a child of an archived parent in the list, where it can still be found", () => {
    const model = buildTree({
      ...base,
      sessions: [
        shellSession({ id: "p", projectId: "p1", archivedAt: 3 }),
        shellSession({ id: "c", projectId: "p1", parentId: "p" }),
      ],
    });
    expect(ids(model.groups[0]?.sessions ?? [])).toEqual(["c"]);
    expect(model.children.size).toBe(0);
  });

  it("counts a filed child among the sessions the browser holds, so 'older' stays true", () => {
    const two = new Map([["p1", shellProject({ id: "p1", name: "api", sessions: 2 })]]);
    const model = buildTree({
      ...base,
      projects: two,
      sessions: [
        shellSession({ id: "p", projectId: "p1" }),
        shellSession({ id: "c", projectId: "p1", parentId: "p" }),
      ],
    });
    expect(model.groups[0]?.older).toBe(0);
  });

  it("leaves an archived child out, and a pinned child pinned", () => {
    const model = buildTree({
      ...base,
      sessions: [
        shellSession({ id: "p", projectId: "p1" }),
        shellSession({ id: "old", projectId: "p1", parentId: "p", archivedAt: 4 }),
        shellSession({ id: "pinned", projectId: "p1", parentId: "p", pinRank: 1 }),
      ],
    });
    expect(model.children.size).toBe(0);
    expect(ids(model.pinned)).toEqual(["pinned"]);
  });

  it("keeps a parent when only its child matches the filter, and drops it when neither does", () => {
    const sessions = [
      shellSession({ id: "p", projectId: "p1", name: "alpha" }),
      shellSession({ id: "c", projectId: "p1", parentId: "p", name: "needle task" }),
    ];
    const hit = buildTree({ ...base, sessions, filter: "needle" });
    expect(ids(hit.groups[0]?.sessions ?? [])).toEqual(["p"]);
    expect(ids(hit.children.get("p") ?? [])).toEqual(["c"]);
    const miss = buildTree({ ...base, sessions, filter: "zzz" });
    expect(miss.groups).toEqual([]);
  });

  it("shows only the children that match, under a parent that matches by its own name", () => {
    const sessions = [
      shellSession({ id: "p", projectId: "p1", name: "alpha" }),
      shellSession({ id: "c1", projectId: "p1", parentId: "p", name: "alpha scan" }),
      shellSession({ id: "c2", projectId: "p1", parentId: "p", name: "beta" }),
    ];
    const model = buildTree({ ...base, sessions, filter: "alpha" });
    expect(ids(model.children.get("p") ?? [])).toEqual(["c1"]);
  });
});
