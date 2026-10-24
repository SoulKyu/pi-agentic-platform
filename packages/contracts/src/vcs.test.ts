import { describe, expect, it } from "vitest";
import { DiffSide, RepoPath, VcsStatus, VcsStreamEvent, VCS_LIMITS } from "./vcs.ts";
import { methods } from "./methods.ts";
import { STREAMS } from "./streams.ts";

describe("RepoPath", () => {
  it("accepts a relative canonical path", () => {
    for (const ok of ["a", "a/b.txt", "dir/.hidden", "sp ace/é"])
      expect(RepoPath.safeParse(ok).success, ok).toBe(true);
  });
  it("refuses an absolute, doubled, dotted or NUL path", () => {
    for (const bad of ["/a", "a//b", "./a", "a/../b", "a\u0000", "", "a/", "..", "a/./b", "x".repeat(4097)])
      expect(RepoPath.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("DiffSide", () => {
  const oid40 = "a".repeat(40);
  it("accepts the three named sides and a commit by 40 or 64 hex digits", () => {
    for (const kind of ["worktree", "index", "head"])
      expect(DiffSide.safeParse({ kind }).success, kind).toBe(true);
    expect(DiffSide.safeParse({ kind: "commit", oid: oid40 }).success).toBe(true);
    expect(DiffSide.safeParse({ kind: "commit", oid: "0123456789abcdef".repeat(4) }).success).toBe(true);
  });
  it("refuses a commit by name, a short or upper-case oid and an unknown kind", () => {
    for (const oid of ["HEAD", "a".repeat(39), "A".repeat(40), "a".repeat(41), "a".repeat(63), ""])
      expect(DiffSide.safeParse({ kind: "commit", oid }).success, oid).toBe(false);
    expect(DiffSide.safeParse({ kind: "branch", name: "main" }).success).toBe(false);
    expect(DiffSide.safeParse({ kind: "commit" }).success).toBe(false);
  });
});

describe("VcsStatus and the stream", () => {
  const status = {
    root: "/r",
    repo: true,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    truncated: false,
    additions: 0,
    deletions: 0,
    at: 1,
    error: null,
  };
  it("accepts a snapshot of nothing and a status, and bounds branch, upstream and the file list", () => {
    expect(VcsStreamEvent.safeParse({ kind: "snapshot", status: null }).success).toBe(true);
    expect(VcsStreamEvent.safeParse({ kind: "status", status }).success).toBe(true);
    expect(VcsStreamEvent.safeParse({ kind: "status", status: null }).success).toBe(false);
    expect(
      VcsStatus.safeParse({ ...status, branch: "b".repeat(256), upstream: "u".repeat(512) }).success,
    ).toBe(true);
    expect(VcsStatus.safeParse({ ...status, branch: "b".repeat(257) }).success).toBe(false);
    expect(VcsStatus.safeParse({ ...status, upstream: "u".repeat(513) }).success).toBe(false);
    const file = {
      path: "a",
      oldPath: null,
      folder: false,
      index: ".",
      worktree: "M",
      kind: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
    };
    expect(VcsStatus.safeParse({ ...status, files: Array(VCS_LIMITS.files).fill(file) }).success).toBe(true);
    expect(VcsStatus.safeParse({ ...status, files: Array(VCS_LIMITS.files + 1).fill(file) }).success).toBe(
      false,
    );
  });
});

describe("the vcs methods", () => {
  it("are three idempotent vcs:read reads and the stream is registered", () => {
    expect(STREAMS).toContain("vcs");
    for (const name of ["subscribe.vcs", "vcs.refresh", "vcs.fileDiff"] as const)
      expect(methods[name]).toMatchObject({ permission: "vcs:read", idempotent: true });
    expect(methods["vcs.fileDiff"].errors).toEqual(["not_found", "capacity", "timeout", "box_stopped"]);
    expect(methods["subscribe.vcs"].errors).toEqual(["not_found", "capacity", "box_stopped"]);
  });
  it("takes an absolute root and relative paths for a diff", () => {
    const { params } = methods["vcs.fileDiff"];
    const base = { root: "/r", path: "a.txt", from: { kind: "head" }, to: { kind: "worktree" } };
    expect(params.safeParse(base).success).toBe(true);
    expect(params.safeParse({ ...base, oldPath: "b.txt" }).success).toBe(true);
    for (const bad of [
      { root: "r" },
      { path: "/a" },
      { oldPath: "../a" },
      { from: { kind: "commit", oid: "x" } },
    ])
      expect(params.safeParse({ ...base, ...bad }).success).toBe(false);
  });
});
