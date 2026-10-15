import type { ShellSession } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { taskView } from "../../testing/home-fixtures.ts";
import { fanoutView, laneView } from "../../testing/lane-fixtures.ts";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import { filterRows, type RecentInput, recentRows } from "./recent-work.vm.ts";

const NOW = 1_800_000_000_000;
const FANOUT = "0123456789abcdef";
const api = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 2 });
const web = shellProject({ id: "p2", name: "web", root: "/w/web", sessions: 1 });
const held = (...list: ShellSession[]) => new Map(list.map((session) => [session.id, session]));
const input = (patch: Partial<RecentInput> = {}): RecentInput => ({
  project: api,
  sessions: new Map(),
  projects: new Map([
    [api.id, api],
    [web.id, web],
  ]),
  lanes: [],
  fanouts: new Map(),
  tasks: [],
  now: NOW,
  ...patch,
});

describe("recentRows (§3.4)", () => {
  it("merges the project's sessions, lanes and tasks, newest activity first, each with its target", () => {
    const rows = recentRows(
      input({
        sessions: held(
          shellSession({ id: "s1", projectId: "p1", updatedAt: 30, name: "Fix login" }),
          shellSession({ id: "s2", projectId: "p2", updatedAt: 90 }),
        ),
        lanes: [laneView({ id: "l-1a2b", projectRoot: "/w/api", createdAt: 50, title: "Cache" })],
        tasks: [taskView({ id: "t1", createdAt: 10, endedAt: 70, title: "Nightly" })],
      }),
    );
    expect(rows.map((row) => [row.kind, row.title, row.at])).toEqual([
      ["task", "Nightly", 70],
      ["lane", "Cache", 50],
      ["session", "Fix login", 30],
    ]);
    expect(rows.map((row) => row.target)).toEqual([
      { kind: "tasks" },
      { kind: "lane", id: "l-1a2b" },
      { kind: "session", id: "s1" },
    ]);
  });

  it("leaves out archived, settled and snoozed sessions, and labels the others by name, preview or folder", () => {
    const rows = recentRows(
      input({
        sessions: held(
          shellSession({ id: "a", projectId: "p1", archivedAt: 5, updatedAt: 9 }),
          shellSession({ id: "b", projectId: "p1", settledAt: 5, updatedAt: 8 }),
          shellSession({ id: "c", projectId: "p1", snoozedUntil: NOW + 60_000, updatedAt: 7 }),
          shellSession({ id: "d", projectId: "p1", preview: "fix the tests", updatedAt: 6 }),
          shellSession({ id: "e", projectId: "p1", cwd: "/w/api/e", updatedAt: 5 }),
        ),
      }),
    );
    expect(rows.map((row) => row.title)).toEqual(["fix the tests", "e"]);
  });

  it("does not list a lane's or a task's session twice (Review Focus 5)", () => {
    const rows = recentRows(
      input({
        sessions: held(
          shellSession({ id: "lane-s", projectId: "p1", cwd: "/p/worktrees/l-1a2b", updatedAt: 80 }),
          shellSession({ id: "deep", projectId: "p1", cwd: "/p/worktrees/l-1a2b/src", updatedAt: 81 }),
          shellSession({ id: "task-s", projectId: "p1", cwd: "/w/api", updatedAt: 82 }),
          shellSession({ id: "mine", projectId: "p1", cwd: "/w/api", updatedAt: 83 }),
        ),
        lanes: [laneView({ id: "l-1a2b", projectRoot: "/w/api", primarySessionId: "lane-s", createdAt: 1 })],
        tasks: [taskView({ id: "t1", sessionId: "task-s", createdAt: 2 })],
      }),
    );
    expect(rows.map((row) => [row.key, row.at])).toEqual([
      ["session:mine", 83],
      ["task:t1", 82],
      ["lane:l-1a2b", 80],
    ]);
    expect(rows.find((row) => row.kind === "task")?.target).toEqual({ kind: "session", id: "task-s" });
  });

  it("groups a fan-out's lanes, live and archived, into one row that reopens its compare (Review Focus 5)", () => {
    const rows = recentRows(
      input({
        lanes: [
          laneView({ id: "a-1a2b", projectRoot: "/w/api", fanoutId: FANOUT, fanoutSlot: 0, createdAt: 10 }),
          laneView({
            id: "b-1a2b",
            projectRoot: "/w/api",
            fanoutId: FANOUT,
            state: "archived",
            archivedAt: 40,
          }),
          // The same lane in the archived page as well: the live copy counts, once.
          laneView({
            id: "a-1a2b",
            projectRoot: "/w/api",
            fanoutId: FANOUT,
            state: "archived",
            archivedAt: 99,
          }),
        ],
        fanouts: new Map([[FANOUT, fanoutView({ id: FANOUT, prompt: "Try three caches\nwith details" })]]),
      }),
    );
    expect(rows).toEqual([
      {
        kind: "fanout",
        key: `fanout:${FANOUT}`,
        title: "Try three caches",
        state: "active",
        lanes: 2,
        at: 40,
        projectId: "p1",
        target: { kind: "compare", id: FANOUT },
      },
    ]);
  });

  it("calls a fan-out whose lanes are all archived archived, and still reopens its compare", () => {
    const rows = recentRows(
      input({
        lanes: [
          laneView({
            id: "a-1a2b",
            projectRoot: "/w/api",
            fanoutId: FANOUT,
            state: "archived",
            archivedAt: 3,
            title: "One",
          }),
        ],
      }),
    );
    expect(rows).toMatchObject([
      { kind: "fanout", state: "archived", title: "One", target: { kind: "compare", id: FANOUT } },
    ]);
  });

  it("lists every project's work under All projects", () => {
    const rows = recentRows(
      input({
        project: null,
        sessions: held(
          shellSession({ id: "s1", projectId: "p1", updatedAt: 2 }),
          shellSession({ id: "s2", projectId: "p2", updatedAt: 1 }),
        ),
        lanes: [laneView({ id: "w-1a2b", projectRoot: "/w/web", createdAt: 3 })],
      }),
    );
    expect(rows.map((row) => [row.key, row.projectId])).toEqual([
      ["lane:w-1a2b", "p2"],
      ["session:s1", "p1"],
      ["session:s2", "p2"],
    ]);
  });
});

describe("filterRows", () => {
  it("keeps sessions, lanes with their fan-outs, or tasks", () => {
    const rows = recentRows(
      input({
        sessions: held(shellSession({ id: "s1", projectId: "p1", updatedAt: 4 })),
        lanes: [
          laneView({ id: "l-1a2b", projectRoot: "/w/api", createdAt: 3 }),
          laneView({ id: "f-1a2b", projectRoot: "/w/api", fanoutId: FANOUT, createdAt: 2 }),
        ],
        tasks: [taskView({ id: "t1", createdAt: 1 })],
      }),
    );
    expect(filterRows(rows, "all").map((row) => row.kind)).toEqual(["session", "lane", "fanout", "task"]);
    expect(filterRows(rows, "sessions").map((row) => row.kind)).toEqual(["session"]);
    expect(filterRows(rows, "lanes").map((row) => row.kind)).toEqual(["lane", "fanout"]);
    expect(filterRows(rows, "tasks").map((row) => row.kind)).toEqual(["task"]);
  });
});
