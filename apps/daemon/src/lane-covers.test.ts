import { describe, expect, it } from "vitest";
import { withLaneRoots } from "./lane-covers.ts";
import type { ProjectsPort } from "./modules/projects/index.ts";

const projects = {
  covers: (owner: string, path: string) =>
    owner === "u1" && (path.startsWith("/w/api") || path.startsWith("/boxes/b1/project")),
  coversHost: (owner: string, path: string) => owner === "u1" && path.startsWith("/w/api"),
  roots: () => ["/w/api"],
} as unknown as ProjectsPort;
const lanes = (owner: string): readonly string[] =>
  owner === "u1" ? ["/p/worktrees/fix-1a2b"] : ["/p/worktrees/fix-9z9z"];
const covers = withLaneRoots(projects, lanes).covers;

describe("withLaneRoots (final review I1)", () => {
  it("keeps the project answer and adds the owner's own lane folders and what is inside them", () => {
    expect(covers("u1", "/w/api/src")).toBe(true);
    expect(covers("u1", "/p/worktrees/fix-1a2b")).toBe(true);
    expect(covers("u1", "/p/worktrees/fix-1a2b/src/deep")).toBe(true);
  });

  it("refuses another owner's lane, a lookalike name, a traversal and anything that is not a clean path", () => {
    expect(covers("u1", "/p/worktrees/fix-9z9z")).toBe(false);
    expect(covers("u2", "/p/worktrees/fix-1a2b")).toBe(false);
    expect(covers("u1", "/p/worktrees/fix-1a2b-evil")).toBe(false);
    expect(covers("u1", "/p/worktrees/fix-1a2b/../fix-9z9z")).toBe(false);
    expect(covers("u1", "/p/worktrees/fix-1a2b/\0x")).toBe(false);
    expect(covers("u1", "p/worktrees/fix-1a2b")).toBe(false);
    expect(covers("u1", "/p/worktrees")).toBe(false);
  });

  it("answers from the roots at call time: an archived lane is no longer covered", () => {
    let roots: readonly string[] = ["/p/worktrees/fix-1a2b"];
    const live = withLaneRoots(projects, () => roots).covers;
    expect(live("u1", "/p/worktrees/fix-1a2b")).toBe(true);
    roots = [];
    expect(live("u1", "/p/worktrees/fix-1a2b")).toBe(false);
  });

  it("never covers a box project's root, though the projects do (a helper would open its host path)", () => {
    expect(covers("u1", "/boxes/b1/project")).toBe(false);
    expect(covers("u1", "/boxes/b1/project/src")).toBe(false);
  });
});
