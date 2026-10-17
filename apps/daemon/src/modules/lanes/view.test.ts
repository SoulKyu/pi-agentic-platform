import { LANE_LIMITS, LaneView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import type { LaneRow } from "./store.ts";
import { viewOf } from "./view.ts";

const row = (description: string): LaneRow =>
  ({
    id: "a-1a2b",
    ownerId: "u1",
    workspaceId: "w",
    createdBy: "token",
    projectRoot: "/srv/project",
    worktree: "/srv/pap/worktrees/a-1a2b",
    branch: "pi/a",
    baseRef: "refs/heads/main",
    baseOid: "a".repeat(40),
    title: "A",
    description,
    source: null,
    model: null,
    primarySessionId: null,
    fanoutId: null,
    fanoutSlot: null,
    setupState: "none",
    setupExit: null,
    setupStartedAt: null,
    setupFinishedAt: null,
    testState: "none",
    testExit: null,
    testFinishedAt: null,
    firstRunEndedAt: null,
    note: null,
    noteAt: null,
    prNumber: null,
    prUrl: null,
    state: "active",
    failedReason: null,
    archivedAt: null,
    createdAt: 1,
  }) as unknown as LaneRow;

describe("viewOf description preview", () => {
  it("passes a short description whole, unflagged", () => {
    const view = viewOf(row("fix the login"), []);
    expect(view.descriptionPreview).toBe("fix the login");
    expect(view.descriptionTruncated).toBe(false);
  });

  it("keeps exactly the preview limit unflagged", () => {
    const view = viewOf(row("x".repeat(LANE_LIMITS.descriptionPreview)), []);
    expect(view.descriptionPreview).toHaveLength(LANE_LIMITS.descriptionPreview);
    expect(view.descriptionTruncated).toBe(false);
  });

  it("clips a 20 000 character description to the limit and flags it, still a valid view", () => {
    const view = viewOf(row("y".repeat(LANE_LIMITS.description)), []);
    expect(view.descriptionPreview).toBe("y".repeat(LANE_LIMITS.descriptionPreview));
    expect(view.descriptionTruncated).toBe(true);
    expect(LaneView.safeParse(view).success).toBe(true);
  });
});
