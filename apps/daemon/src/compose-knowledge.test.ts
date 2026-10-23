import { describe, expect, it, vi } from "vitest";
import { composeKnowledge } from "./compose-knowledge.ts";

const project = { id: "p1", root: "/w/api", name: "api", position: 0 };
const lane = { ownerId: "o1", projectRoot: "/w/api", worktree: "/home/.pap/lanes/api/l1" };

function build(overrides: { projects?: unknown[]; laneOf?: (cwd: string) => unknown } = {}) {
  const append = vi.fn();
  const knowledge = composeKnowledge({ append }, () => ({
    projects: {
      port: {
        list: () => (overrides.projects ?? [project]) as never,
        covers: (_owner: string, path: string) => path.startsWith("/w/"),
      },
    },
    lanes: { paths: { laneOf: (overrides.laneOf ?? (() => null)) as never } },
    sessions: { cwdOf: (_owner: string, sessionId: string) => (sessionId === "s1" ? "/w/api/src" : null) },
  }));
  return { knowledge, append };
}

describe("composeKnowledge", () => {
  it("roots a plain session at its project folder, not its own", () => {
    const { knowledge } = build();
    expect(knowledge.rootOfRow({ ownerId: "o1", cwd: "/w/api/src" }, "/w/api")).toBe("/w/api");
  });

  it("roots a lane session at its worktree", () => {
    const { knowledge } = build({ laneOf: (cwd) => (cwd.startsWith(lane.worktree) ? lane : null) });
    expect(knowledge.rootOfRow({ ownerId: "o1", cwd: `${lane.worktree}/src` }, "/w/api")).toBe(lane.worktree);
  });

  it("ignores a lane of another owner, or of another project", () => {
    const foreign = build({ laneOf: () => ({ ...lane, ownerId: "o2" }) }).knowledge;
    expect(foreign.rootOfRow({ ownerId: "o1", cwd: lane.worktree }, "/w/api")).toBe("/w/api");
    const other = build({ laneOf: () => ({ ...lane, projectRoot: "/w/other" }) }).knowledge;
    expect(other.rootFor("o1", "p1", "s1")).toBe("/w/api");
  });

  it("has no root for a folder outside every project", () => {
    expect(build().knowledge.rootOfRow({ ownerId: "o1", cwd: "/tmp/x" }, "/tmp/x")).toBeNull();
  });

  it("has no root for an unknown project", () => {
    expect(build({ projects: [] }).knowledge.rootFor("o1", "p9")).toBeNull();
  });

  it("resolves a project's root through the session's folder", () => {
    const { knowledge } = build({ laneOf: () => lane });
    expect(knowledge.rootFor("o1", "p1", "s1")).toBe(lane.worktree);
    expect(knowledge.rootFor("o1", "p1", "unknown")).toBe("/w/api");
    expect(knowledge.rootFor("o1", "p1")).toBe("/w/api");
  });

  it("audits an enable as a policy row", () => {
    const { knowledge, append } = build();
    knowledge.enabled({ userId: "o1", kind: "session" } as never, "p1");
    expect(append).toHaveBeenCalledExactlyOnceWith({
      ownerId: "o1",
      actor: "user",
      kind: "policy",
      reason: "knowledge_enabled",
      detail: { projectId: "p1" },
    });
  });
});
