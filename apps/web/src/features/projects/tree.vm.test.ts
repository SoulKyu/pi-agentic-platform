import { describe, expect, it } from "vitest";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import { buildTree, ROWS_PER_PROJECT, SHELF_ROWS } from "./tree.vm.ts";

const NOW = 1_800_000_000_000;
const projects = new Map([
  ["p1", shellProject({ id: "p1", name: "api", position: 2, sessions: 3 })],
  ["p2", shellProject({ id: "p2", name: "web", position: 1, sessions: 1 })],
]);
const base = { projects, filter: "", projectId: null, shown: new Map<string, number>(), now: NOW };
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((s) => s.id);

describe("the project tree", () => {
  it("puts pinned sessions on top by rank, then projects in order, newest first, and the shelves", () => {
    const model = buildTree({
      ...base,
      sessions: [
        shellSession({ id: "a", projectId: "p1", updatedAt: 3 }),
        shellSession({ id: "b", projectId: "p1", updatedAt: 9 }),
        shellSession({ id: "c", projectId: "p2", updatedAt: 1 }),
        shellSession({ id: "pin2", projectId: "p1", pinRank: 2 }),
        shellSession({ id: "pin1", projectId: "p2", pinRank: 1 }),
        shellSession({ id: "free", projectId: null, updatedAt: 5 }),
        shellSession({ id: "zz", projectId: "p1", snoozedUntil: NOW + 1000 }),
        shellSession({ id: "awake", projectId: "p1", snoozedUntil: NOW - 1, updatedAt: 4 }),
        shellSession({ id: "st", projectId: "p2", settledAt: 7 }),
        shellSession({ id: "ar", projectId: "p1", archivedAt: 8 }),
      ],
    });
    expect(ids(model.pinned)).toEqual(["pin1", "pin2"]);
    expect(model.groups.map((g) => [g.project?.id ?? null, ids(g.sessions)])).toEqual([
      ["p2", ["c"]],
      ["p1", ["b", "awake", "a"]],
      [null, ["free"]],
    ]);
    expect(ids(model.snoozed)).toEqual(["zz"]);
    expect(ids(model.settled)).toEqual(["st"]);
    expect(model.empty).toBe(false);
  });

  it("caps a project at 20 rows, shows more on demand, and counts sessions the browser does not hold", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      shellSession({ id: `s${i}`, projectId: "p1", updatedAt: i }),
    );
    const big = new Map([["p1", shellProject({ id: "p1", sessions: 45 })]]);
    const model = buildTree({ ...base, projects: big, sessions: many });
    expect([model.groups[0]?.sessions.length, model.groups[0]?.hidden, model.groups[0]?.older]).toEqual([
      ROWS_PER_PROJECT,
      10,
      15,
    ]);
    const more = buildTree({ ...base, projects: big, sessions: many, shown: new Map([["p1", 40]]) });
    expect([more.groups[0]?.sessions.length, more.groups[0]?.hidden]).toEqual([30, 0]);
  });

  it("shows a project whose active sessions the browser does not hold as a heading with its older line (RT-09)", () => {
    const withOld = new Map([
      ...projects,
      ["p3", shellProject({ id: "p3", name: "old", position: 0, sessions: 3 })],
    ]);
    const sessions = [shellSession({ id: "a", projectId: "p1" }), shellSession({ id: "c", projectId: "p2" })];
    const model = buildTree({ ...base, projects: withOld, sessions });
    expect(model.groups.map((g) => [g.project?.id, ids(g.sessions), g.older])).toEqual([
      ["p3", [], 3],
      ["p2", ["c"], 0],
      ["p1", ["a"], 2],
    ]);
    expect(
      buildTree({ ...base, projects: withOld, sessions, filter: "a" }).groups.some(
        (g) => g.project?.id === "p3",
      ),
    ).toBe(false);
    expect(
      buildTree({ ...base, projects: withOld, sessions, projectId: "p1" }).groups.map((g) => g.project?.id),
    ).toEqual(["p1"]);
    expect(
      buildTree({ ...base, projects: withOld, sessions, projectId: "p3" }).groups.map((g) => [
        g.project?.id,
        g.older,
      ]),
    ).toEqual([["p3", 3]]);
  });

  it("filters on label, folder and project name, accents and case aside, and then hides the older counts", () => {
    const sessions = [
      shellSession({ id: "x", projectId: "p1", name: "Déploiement" }),
      shellSession({ id: "y", projectId: "p2", cwd: "/w/web" }),
      shellSession({ id: "z", projectId: "p1", preview: "other" }),
    ];
    expect(
      ids(buildTree({ ...base, sessions, filter: "deploie" }).groups.flatMap((g) => g.sessions)),
    ).toEqual(["x"]);
    expect(ids(buildTree({ ...base, sessions, filter: "WEB" }).groups.flatMap((g) => g.sessions))).toEqual([
      "y",
    ]);
    expect(buildTree({ ...base, sessions, filter: "api" }).groups.map((g) => g.older)).toEqual([0]);
  });

  it("narrows to the current project but keeps every pinned session (M4R93)", () => {
    const sessions = [
      shellSession({ id: "a", projectId: "p1" }),
      shellSession({ id: "b", projectId: "p2" }),
      shellSession({ id: "pin", projectId: "p2", pinRank: 1 }),
      shellSession({ id: "st", projectId: "p2", settledAt: 1 }),
    ];
    const model = buildTree({ ...base, sessions, projectId: "p1" });
    expect([ids(model.pinned), model.groups.map((g) => g.project?.id), ids(model.settled)]).toEqual([
      ["pin"],
      ["p1"],
      [],
    ]);
  });

  it("caps the shelves at 50 and counts the rest", () => {
    const settled = Array.from({ length: 60 }, (_, i) => shellSession({ id: `t${i}`, settledAt: i }));
    const model = buildTree({ ...base, projects: new Map(), sessions: settled });
    expect([model.settled.length, model.settledMore, model.settled[0]?.id]).toEqual([SHELF_ROWS, 10, "t59"]);
    const asleep = Array.from({ length: 55 }, (_, i) =>
      shellSession({ id: `n${i}`, snoozedUntil: NOW + 1000 + i }),
    );
    const naps = buildTree({ ...base, projects: new Map(), sessions: asleep });
    expect([naps.snoozed.length, naps.snoozedMore, naps.snoozed[0]?.id]).toEqual([SHELF_ROWS, 5, "n0"]);
  });

  it("folds sessions of an unknown project into the one group without a project (unique keys)", () => {
    const model = buildTree({
      ...base,
      projects: new Map([["p1", shellProject({ id: "p1", name: "api", sessions: 1 })]]),
      sessions: [
        shellSession({ id: "free", projectId: null, updatedAt: 2 }),
        shellSession({ id: "ghost", projectId: "gone", updatedAt: 3 }),
        shellSession({ id: "a", projectId: "p1" }),
      ],
    });
    expect(model.groups.map((g) => [g.project?.id ?? null, ids(g.sessions)])).toEqual([
      ["p1", ["a"]],
      [null, ["ghost", "free"]],
    ]);
    const keys = model.groups.map((g) => g.project?.id ?? "");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is empty when nothing shows", () => {
    expect(
      buildTree({ ...base, projects: new Map(), sessions: [shellSession({ id: "ar", archivedAt: 1 })] })
        .empty,
    ).toBe(true);
  });
});
