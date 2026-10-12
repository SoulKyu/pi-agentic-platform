import { describe, expect, it } from "vitest";
import { shellProject, shellSession, shellSnapshot } from "../testing/shell-snapshot.ts";
import {
  confirm,
  EMPTY_SHELL,
  failShell,
  MAX_STORE_PROJECTS,
  MAX_STORE_SESSIONS,
  optimistic,
  pinnedIds,
  reduceShell,
  rollback,
} from "./shell-reducer.ts";

const loaded = (sessions = [shellSession({ id: "a" }), shellSession({ id: "b", pinRank: 1 })]) =>
  reduceShell(
    EMPTY_SHELL,
    shellSnapshot(sessions, {
      projects: [shellProject({ id: "p1" })],
      more: 3,
      moreProjects: 4,
      archived: 2,
    }),
  );

describe("shell reducer", () => {
  it("a snapshot replaces the view, clears a failure and drops pending changes (M4R81)", () => {
    const pending = optimistic(failShell(loaded(), "capacity"), "c1", {
      sessions: [shellSession({ id: "a", pinRank: 2 })],
    });
    const view = reduceShell(pending, shellSnapshot([shellSession({ id: "z" })]));
    expect([...view.sessions.keys()]).toEqual(["z"]);
    expect([
      view.loaded,
      view.failed,
      view.pending.size,
      view.more,
      view.moreProjects,
      view.archived,
    ]).toEqual([true, null, 0, 0, 0, 0]);
    expect(loaded().moreProjects).toBe(4);
  });

  it("says a refused subscription without pretending to be loaded (M4R138)", () => {
    expect(failShell(EMPTY_SHELL, "capacity")).toMatchObject({ loaded: false, failed: "capacity" });
  });

  it("upserts sessions and projects, and takes the archived count", () => {
    let view = loaded();
    view = reduceShell(view, { kind: "session", session: shellSession({ id: "a", name: "renamed" }) });
    view = reduceShell(view, { kind: "project", project: shellProject({ id: "p2" }) });
    view = reduceShell(view, { kind: "counts", archived: 7 });
    expect(view.sessions.get("a")?.name).toBe("renamed");
    expect([...view.projects.keys()]).toEqual(["p1", "p2"]);
    expect(view.archived).toBe(7);
  });

  it("an unreadable snapshot says so; another unreadable event is dropped", () => {
    expect(reduceShell(EMPTY_SHELL, { kind: "snapshot", sessions: "no" })).toMatchObject({
      loaded: true,
      unreadable: true,
    });
    const view = loaded();
    expect(reduceShell(view, { kind: "session", session: { id: 1 } })).toBe(view);
  });

  it("stays bounded: archived go first, then the oldest unpinned; pinned stay (M4R80)", () => {
    let view = loaded([]);
    view = reduceShell(view, {
      kind: "session",
      session: shellSession({ id: "pin", pinRank: 1, updatedAt: 0 }),
    });
    view = reduceShell(view, {
      kind: "session",
      session: shellSession({ id: "arch", archivedAt: 1, updatedAt: 999_999 }),
    });
    for (let i = 0; i < MAX_STORE_SESSIONS; i++)
      view = reduceShell(view, {
        kind: "session",
        session: shellSession({ id: `s${i}`, updatedAt: 10 + i }),
      });
    expect(view.sessions.size).toBe(MAX_STORE_SESSIONS);
    expect(view.sessions.has("pin")).toBe(true);
    expect(view.sessions.has("arch")).toBe(false);
    expect(view.sessions.has("s0")).toBe(false);
    expect(view.sessions.has(`s${MAX_STORE_SESSIONS - 1}`)).toBe(true);
  });

  it("keeps the projects held sessions name, and evicts empty unnamed ones first (M4R80)", () => {
    let view = loaded([shellSession({ id: "a", projectId: "named" })]);
    view = reduceShell(view, { kind: "project", project: shellProject({ id: "named", sessions: 0 }) });
    view = reduceShell(view, { kind: "project", project: shellProject({ id: "empty", sessions: 0 }) });
    for (let i = 0; i < MAX_STORE_PROJECTS; i++)
      view = reduceShell(view, { kind: "project", project: shellProject({ id: `q${i}`, sessions: 1 }) });
    expect(view.projects.size).toBe(MAX_STORE_PROJECTS);
    expect([view.projects.has("named"), view.projects.has("empty")]).toEqual([true, false]);
  });

  it("shows an optimistic change, confirms it, or rolls it back (M4R82)", () => {
    const view = loaded();
    const after = shellSession({ id: "a", archivedAt: 5 });
    const shown = optimistic(view, "c1", { sessions: [after] });
    expect(shown.sessions.get("a")).toBe(after);
    expect(confirm(shown, "c1").pending.size).toBe(0);
    expect(confirm(shown, "c1").sessions.get("a")).toBe(after);
    expect(rollback(shown, "c1").sessions.get("a")).toBe(view.sessions.get("a"));
  });

  it("a rollback never overwrites a newer server event", () => {
    const shown = optimistic(loaded(), "c1", { sessions: [shellSession({ id: "a", archivedAt: 5 })] });
    const moved = reduceShell(shown, {
      kind: "session",
      session: shellSession({ id: "a", status: "running" }),
    });
    const newer = moved.sessions.get("a");
    expect(newer).toMatchObject({ status: "running", archivedAt: null });
    expect(rollback(moved, "c1").sessions.get("a")).toBe(newer);
  });

  it("rolls back project changes the same way", () => {
    const view = loaded();
    const renamed = shellProject({ id: "p1", name: "new" });
    const shown = optimistic(view, "c2", { projects: [renamed] });
    expect(shown.projects.get("p1")?.name).toBe("new");
    expect(rollback(shown, "c2").projects.get("p1")?.name).toBe("p1");
  });

  it("pinnedIds lists the pinned sessions by rank", () => {
    const view = loaded([
      shellSession({ id: "x", pinRank: 2 }),
      shellSession({ id: "y", pinRank: 1 }),
      shellSession({ id: "z" }),
    ]);
    expect(pinnedIds(view)).toEqual(["y", "x"]);
  });
});
