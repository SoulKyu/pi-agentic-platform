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
});
