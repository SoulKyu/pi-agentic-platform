import {
  NO_MARKS,
  type ProjectSummary,
  type ShellSession,
  SHELL_LIMITS,
  ShellStreamEvent,
} from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { fitShellSnapshot, fitSummaries, summaryOf } from "./shell.ts";

const summary = (id: string, projectId: string | null, cwd = `/w/${id}`): ShellSession => ({
  id,
  cwd,
  name: null,
  preview: null,
  status: "cold",
  toolPreset: "configured",
  needsInput: false,
  projectId,
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  createdAt: 1,
  updatedAt: 2,
});
const project = (id: string, position = 1): ProjectSummary => ({
  id,
  root: `/w/${id}`,
  name: id,
  position,
  sessions: 2,
});

describe("shell summaries", () => {
  it("maps a row and its live state", () => {
    const row = {
      id: "s1",
      ownerId: "u1",
      cwd: "/w/a",
      name: "n",
      preview: "p",
      projectId: "p1",
      createdAt: 1,
      updatedAt: 2,
      toolPreset: "configured" as const,
      marks: { ...NO_MARKS, pinRank: 2, snoozedUntil: 9 },
    };
    expect(summaryOf(row, { status: "running", needsInput: true })).toEqual({
      id: "s1",
      cwd: "/w/a",
      name: "n",
      preview: "p",
      status: "running",
      toolPreset: "configured",
      needsInput: true,
      projectId: "p1",
      pinRank: 2,
      archivedAt: null,
      settledAt: null,
      snoozedUntil: 9,
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it("names the parent of a subagent's session, and nothing for any other", () => {
    const row = {
      id: "c1",
      ownerId: "u1",
      cwd: "/w/a",
      name: null,
      preview: null,
      projectId: null,
      createdAt: 1,
      updatedAt: 2,
      toolPreset: "configured" as const,
      marks: NO_MARKS,
    };
    const live = { status: "idle", needsInput: false } as const;
    expect(summaryOf({ ...row, parentId: "s1" }, live)).toMatchObject({ parentId: "s1" });
    expect("parentId" in summaryOf(row, live)).toBe(false);
  });

  it("keeps the sessions in order with each named project once, then the other active projects", () => {
    const snapshot = fitShellSnapshot({
      sessions: [summary("a", "p1"), summary("b", "p1"), summary("c", null)],
      projects: [project("p2", 1), project("p1", 2)],
      active: 5,
      archived: 4,
    });
    expect(snapshot).toEqual({
      kind: "snapshot",
      projects: [project("p1", 2), project("p2", 1)],
      sessions: [summary("a", "p1"), summary("b", "p1"), summary("c", null)],
      more: 2,
      moreProjects: 0,
      archived: 4,
    });
  });

  it("lists the other active projects up to 500 in all, and counts the rest (owner Q15)", () => {
    const projects = Array.from({ length: 600 }, (_, i) => project(`p${i}`, i));
    const snapshot = fitShellSnapshot({ sessions: [summary("s", "p599")], projects, active: 1, archived: 0 });
    expect(snapshot.projects.map((p) => p.id)).toEqual(["p599", ...projects.slice(0, 499).map((p) => p.id)]);
    expect(snapshot.moreProjects).toBe(100);
  });

  it("stops at the budget and never cuts the order", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => summary(`s${i}`, null, `/w/${"x".repeat(200)}`));
    const snapshot = fitShellSnapshot({ sessions, projects: [], active: 10, archived: 0 }, 1500);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(1500);
    expect(snapshot.sessions.map((s) => s.id)).toEqual(
      sessions.slice(0, snapshot.sessions.length).map((s) => s.id),
    );
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.more).toBe(8);
  });

  it("keeps at most 550 rows whatever the budget, and the frame parses", () => {
    const sessions = Array.from({ length: 600 }, (_, i) => summary(`s${String(i).padStart(3, "0")}`, null));
    const snapshot = fitShellSnapshot({ sessions, projects: [], active: 700, archived: 0 });
    expect(snapshot.sessions.map((s) => s.id)).toEqual(sessions.slice(0, 550).map((s) => s.id));
    expect(snapshot.more).toBe(150);
    expect(ShellStreamEvent.safeParse(snapshot).success).toBe(true);
  });

  it("keeps a sixth of the budget for the projects no held session names", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => summary(`s${i}`, null, `/w/${"x".repeat(200)}`));
    const snapshot = fitShellSnapshot({ sessions, projects: [project("p1")], active: 10, archived: 0 }, 1351);
    expect(snapshot.projects).toEqual([project("p1")]);
    expect(snapshot.sessions.length).toBe(2);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(1351);
  });

  it("fits 550 sessions and 2 000 projects with 4096-character folders in one frame", () => {
    const sessions = Array.from({ length: SHELL_LIMITS.sessions + SHELL_LIMITS.pins }, (_, i) =>
      summary(`s${String(i).padStart(4, "0")}`, `p${i}`, `/${"d".repeat(4095)}`),
    );
    const projects = Array.from({ length: 2000 }, (_, i) => ({
      ...project(`p${i}`, i),
      root: `/${"d".repeat(4095)}`,
    }));
    const snapshot = fitShellSnapshot({ sessions, projects, active: 10_000, archived: 0 });
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(PAGE_BYTES);
    expect(ShellStreamEvent.safeParse(snapshot).success).toBe(true);
    expect(snapshot.more).toBe(10_000 - snapshot.sessions.length);
    expect(snapshot.moreProjects).toBe(2000 - snapshot.projects.length);
    expect(snapshot.sessions.length).toBeGreaterThan(0);
  });

  it("fits sessions.list under the page and says when it cut", () => {
    const list = Array.from(
      { length: 300 },
      (_, i) =>
        ({
          id: `s${i}`,
          cwd: `/${"d".repeat(4000)}`,
          name: null,
          status: "cold",
          toolPreset: "configured",
          createdAt: 1,
          updatedAt: 1,
        }) as const,
    );
    const fitted = fitSummaries(list);
    expect(sizeOf({ sessions: fitted.sessions })).toBeLessThanOrEqual(PAGE_BYTES);
    expect(fitted.truncated).toBe(true);
    expect(fitSummaries(list.slice(0, 2))).toEqual({ sessions: list.slice(0, 2), truncated: false });
  });
});
