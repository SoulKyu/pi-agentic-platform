import { describe, expect, it } from "vitest";
import { methods } from "./methods.ts";
import { MarkChange } from "./marks.ts";
import { ProjectChange, ProjectSummary, SHELL_LIMITS, ShellSession, ShellStreamEvent } from "./shell.ts";

const session = {
  id: "s1",
  cwd: "/w/api",
  name: null,
  preview: "fix the tests",
  status: "idle",
  needsInput: false,
  projectId: "p1",
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  createdAt: 1,
  updatedAt: 2,
} as const;
const project = { id: "p1", root: "/w/api", name: "api", position: 1.5, sessions: 3 } as const;

describe("shell schemas (M4)", () => {
  it("parses a snapshot and every live event", () => {
    const events = [
      { kind: "snapshot", projects: [project], sessions: [session], more: 7, moreProjects: 0, archived: 2 },
      { kind: "session", session },
      { kind: "project", project },
      { kind: "counts", archived: 3 },
    ];
    for (const event of events) expect(ShellStreamEvent.parse(event)).toEqual(event);
    expect(ShellStreamEvent.safeParse({ kind: "nope" }).success).toBe(false);
  });

  it("bounds pins, times, previews and names (M4R17)", () => {
    const bad = [
      { pinRank: 0 },
      { pinRank: SHELL_LIMITS.pins + 1 },
      { archivedAt: -1 },
      { snoozedUntil: 8.64e15 + 1 },
      { settledAt: 1.5 },
      { createdAt: 1.5 },
      { updatedAt: -1 },
      { preview: "x".repeat(SHELL_LIMITS.preview * 2 + 1) },
      { id: "" },
      { projectId: "p".repeat(129) },
    ];
    for (const patch of bad)
      expect(ShellSession.safeParse({ ...session, ...patch }).success, JSON.stringify(patch)).toBe(false);
    expect(ProjectSummary.safeParse({ ...project, sessions: -1 }).success).toBe(false);
    expect(ProjectSummary.safeParse({ ...project, root: "" }).success).toBe(false);
  });

  it("files a subagent's session under its parent, or under none", () => {
    expect(ShellSession.parse({ ...session, parentId: "s0" }).parentId).toBe("s0");
    expect(ShellSession.parse({ ...session, parentId: null }).parentId).toBeNull();
    expect(ShellSession.parse(session).parentId).toBeUndefined();
    expect(ShellSession.safeParse({ ...session, parentId: "" }).success).toBe(false);
  });

  it("marks a project no session files under yet with unused: true, and nothing else", () => {
    expect(ProjectSummary.parse({ ...project, sessions: 0, unused: true })).toEqual({
      ...project,
      sessions: 0,
      unused: true,
    });
    expect(ProjectSummary.safeParse({ ...project, unused: false }).success).toBe(false);
    expect(ProjectSummary.parse(project)).toEqual(project);
  });

  it("refuses a snapshot past its session bound", () => {
    const sessions = Array.from({ length: SHELL_LIMITS.sessions + SHELL_LIMITS.pins + 1 }, (_, i) => ({
      ...session,
      id: `s${i}`,
    }));
    expect(
      ShellStreamEvent.safeParse({
        kind: "snapshot",
        projects: [],
        sessions,
        more: 0,
        moreProjects: 0,
        archived: 0,
      }).success,
    ).toBe(false);
    const projects = Array.from({ length: SHELL_LIMITS.sessions + SHELL_LIMITS.pins + 1 }, (_, i) => ({
      ...project,
      id: `p${i}`,
    }));
    expect(
      ShellStreamEvent.safeParse({
        kind: "snapshot",
        projects,
        sessions: [],
        more: 0,
        moreProjects: 0,
        archived: 0,
      }).success,
    ).toBe(false);
  });

  it("decodes every mark change and refuses an unknown one", () => {
    const changes = [
      { kind: "pin", before: null },
      { kind: "pin", before: "s2" },
      { kind: "unpin" },
      { kind: "archive" },
      { kind: "unarchive" },
      { kind: "settle" },
      { kind: "unsettle" },
      { kind: "snooze", until: 1_800_000_000_000 },
      { kind: "wake" },
      {
        kind: "restore",
        state: { pinned: true, pinBefore: null, archived: false, settled: false, snoozedUntil: null },
      },
    ];
    for (const change of changes) expect(MarkChange.parse(change)).toEqual(change);
    expect(MarkChange.safeParse({ kind: "delete" }).success).toBe(false);
    expect(MarkChange.safeParse({ kind: "snooze", until: "tomorrow" }).success).toBe(false);
  });

  it("bounds a project rename and a move", () => {
    expect(ProjectChange.safeParse({ kind: "rename", name: "" }).success).toBe(false);
    expect(
      ProjectChange.safeParse({ kind: "rename", name: "x".repeat(SHELL_LIMITS.projectName * 2 + 1) }).success,
    ).toBe(false);
    expect(ProjectChange.parse({ kind: "move", before: null })).toEqual({ kind: "move", before: null });
  });

  it("subscribe.shell takes no key, only a cursor", () => {
    const { params } = methods["subscribe.shell"];
    expect(params.parse({})).toEqual({});
    expect(params.parse({ after: { epoch: "e", seq: 1 } })).toEqual({ after: { epoch: "e", seq: 1 } });
    expect(params.parse({ userId: "u2" })).toEqual({});
  });

  it("pages the archive by (archivedAt, id), at most 100 a page", () => {
    const { params } = methods["sessions.listArchived"];
    expect(params.parse({ before: { archivedAt: 5, id: "x" }, limit: 100 }).limit).toBe(100);
    expect(params.safeParse({ limit: 101 }).success).toBe(false);
    expect(params.safeParse({ limit: 0 }).success).toBe(false);
    expect(params.safeParse({ before: { archivedAt: -1, id: "x" } }).success).toBe(false);
  });

  it("sessions.list may say it was cut", () => {
    const { result } = methods["sessions.list"];
    expect(result.parse({ sessions: [], truncated: true })).toEqual({ sessions: [], truncated: true });
    expect(result.safeParse({ sessions: [], truncated: false }).success).toBe(false);
  });

  it("search.query is an idempotent read of sessions, bounded in query, limit and hits", () => {
    const method = methods["search.query"];
    expect(method.permission).toBe("sessions:read");
    expect(method.idempotent).toBe(true);
    expect(method.params.safeParse({ q: "" }).success).toBe(false);
    expect(method.params.safeParse({ q: "x".repeat(SHELL_LIMITS.searchQuery + 1) }).success).toBe(false);
    expect(method.params.safeParse({ q: "kube", limit: 21 }).success).toBe(false);
    expect(method.params.parse({ q: "kube", limit: 20 })).toEqual({ q: "kube", limit: 20 });
    const hit = { sessionId: "s1", entryId: "e1", role: "user", at: 1, snippet: "a", session };
    expect(method.result.parse({ hits: [hit] })).toEqual({ hits: [hit] });
    for (const bad of [
      { at: -1 },
      { role: "tool" },
      { entryId: "x".repeat(129) },
      { snippet: "x".repeat(401) },
    ])
      expect(method.result.safeParse({ hits: [{ ...hit, ...bad }] }).success).toBe(false);
    expect(method.result.safeParse({ hits: Array.from({ length: 21 }, () => hit) }).success).toBe(false);
  });
});

describe("projects.add (decision 85)", () => {
  it("is the idempotent sessions:operate method the home's Add project calls, with its four refusals", () => {
    expect(methods["projects.add"]).toMatchObject({
      name: "projects.add",
      permission: "sessions:operate",
      idempotent: true,
      errors: ["invalid_cwd", "bad_request", "capacity", "read_only"],
    });
    const { params, result } = methods["projects.add"];
    expect(params.safeParse({ root: "/w/api" }).success).toBe(true);
    for (const root of ["", "w/api", "/a\u0000b", `/${"a".repeat(4096)}`, 4])
      expect(params.safeParse({ root }).success, String(root)).toBe(false);
    expect(
      result.safeParse({ project: { id: "p1", root: "/w/api", name: "api", position: -1 } }).success,
    ).toBe(true);
    expect(result.safeParse({ project: { id: "p1", root: "/w/api", name: "api" } }).success).toBe(false);
  });
});
