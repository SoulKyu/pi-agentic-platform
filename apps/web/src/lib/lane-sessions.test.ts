import { describe, expect, it } from "vitest";
import { laneView } from "../testing/lane-fixtures.ts";
import { shellSession } from "../testing/shell-snapshot.ts";
import { inLane, laneSessions, laneStatusOf } from "./lane-sessions.ts";

const lane = laneView({ id: "fix-a-1a2b" });
const at = (cwd: string, patch: Partial<Parameters<typeof shellSession>[0]> = {}) =>
  shellSession({ id: cwd, cwd, ...patch });

describe("laneSessions", () => {
  it("the worktree and a subfolder belong; a sibling with a common prefix does not", () => {
    const own = at("/p/worktrees/fix-a-1a2b");
    const sub = at("/p/worktrees/fix-a-1a2b/apps/web");
    const sibling = at("/p/worktrees/fix-a-1a2b-x");
    const other = at("/w/proj");
    expect(laneSessions(lane, [own, sub, sibling, other])).toEqual([own, sub]);
    expect(inLane(lane, "/p/worktrees/fix-a-1a2b-x/y")).toBe(false);
  });

  it("an archived session does not count", () => {
    expect(laneSessions(lane, [at("/p/worktrees/fix-a-1a2b", { archivedAt: 5 })])).toEqual([]);
  });
});

describe("laneStatusOf", () => {
  const cwd = "/p/worktrees/fix-a-1a2b";
  it("a running session works, a waiting one needs attention, none is idle", () => {
    expect(laneStatusOf(lane, [at(cwd, { status: "running" })])).toBe("working");
    expect(laneStatusOf(lane, [at(cwd, { needsInput: true, status: "running" })])).toBe("needs_attention");
    expect(laneStatusOf(lane, [at("/w/proj", { status: "running" })])).toBe("idle");
  });
});
