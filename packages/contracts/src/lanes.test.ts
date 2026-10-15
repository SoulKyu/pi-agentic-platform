import { describe, expect, it } from "vitest";
import {
  BaseRef,
  BranchName,
  FanoutView,
  LaneId,
  LANE_LIMITS,
  LaneTitle,
  LaneView,
  slugOf,
} from "./lanes.ts";

const oid = "a".repeat(40);

describe("BranchName", () => {
  it("accepts the names pap suggests", () => {
    for (const ok of ["pi/fix-412-high-memory", "pi/feat-a.b", "pi/HEAD", "HEADS", "x".repeat(200)])
      expect(BranchName.safeParse(ok).success, ok).toBe(true);
  });
  it("refuses what git would expand, reject or read as an option", () => {
    for (const bad of [
      "@",
      "a@{b",
      "-x",
      "x/",
      "x.",
      "/x",
      "a//b",
      "a/.b",
      "a..b",
      "feat/x.lock",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a\\b",
      "x".repeat(201),
      "HEAD",
      "FETCH_HEAD",
      "ORIG_HEAD",
      "MERGE_HEAD",
    ])
      expect(BranchName.safeParse(bad).success, bad).toBe(false);
  });
});

describe("BaseRef", () => {
  it("takes a full branch name or a commit", () => {
    for (const ok of ["refs/heads/main", "refs/remotes/origin/main", oid])
      expect(BaseRef.safeParse(ok).success, ok).toBe(true);
  });
  it("refuses short names, tags and traversal", () => {
    for (const bad of ["main", "refs/tags/v1", "refs/heads/../x", "refs/heads/-x", "HEAD@{1}"])
      expect(BaseRef.safeParse(bad).success, bad).toBe(false);
  });
});

describe("LaneId and slugOf", () => {
  it("shapes ids as slug-hex4", () => {
    expect(LaneId.safeParse("per-turn-checkpoints-a3f9").success).toBe(true);
    for (const bad of ["x-a3f", "../x-a3f9", "X-a3f9"])
      expect(LaneId.safeParse(bad).success, bad).toBe(false);
  });
  it("slugs ASCII, strips accents and falls back to lane", () => {
    expect(slugOf("Été  chaud!")).toBe("ete-chaud");
    expect(slugOf("***")).toBe("lane");
    expect(slugOf("a".repeat(60))).toHaveLength(40);
  });
});

describe("LaneTitle", () => {
  it("trims and refuses line breaks and bidi controls", () => {
    expect(LaneTitle.parse("  fix it  ")).toBe("fix it");
    expect(LaneTitle.safeParse("a\nb").success).toBe(false);
    expect(LaneTitle.safeParse("a\u202Eb").success).toBe(false);
  });
});

const lane = {
  id: "fix-it-a3f9",
  projectRoot: "/home/me/repo",
  worktree: "/home/me/.pap/worktrees/fix-it-a3f9",
  title: "Fix it",
  branch: "pi/fix-it",
  baseRef: "refs/heads/main",
  baseLabel: "main",
  primarySessionId: null,
  createdBy: "session",
  state: "active",
  failedReason: null,
  setup: { state: "none", exitCode: null, startedAt: null, finishedAt: null },
  tests: { state: "none", exitCode: null, finishedAt: null },
  facts: null,
  pr: null,
  forge: null,
  remote: null,
  pushRemote: null,
  source: { kind: "description" },
  model: null,
  fanoutId: null,
  fanoutSlot: null,
  firstRunEndedAt: null,
  checkpointsFull: false,
  descriptionPreview: "",
  descriptionTruncated: false,
  notices: [],
  archivedAt: null,
  createdAt: 1,
};

describe("LaneView", () => {
  it("takes createdBy, failedReason, pushRemote and up to 8 notices", () => {
    const notice = { kind: "disk_low", at: 1, count: null };
    const eight = { ...lane, createdBy: "token", failedReason: "git", pushRemote: { host: "h", path: "p" } };
    expect(LaneView.safeParse({ ...eight, notices: Array(8).fill(notice) }).success).toBe(true);
    expect(LaneView.safeParse({ ...eight, notices: Array(9).fill(notice) }).success).toBe(false);
  });
});

describe("LaneView description preview", () => {
  it("takes 2000 characters, refuses 2001 and needs the truncation flag", () => {
    expect(LANE_LIMITS.descriptionPreview).toBe(2000);
    const view = { ...lane, descriptionPreview: "x".repeat(2000), descriptionTruncated: true };
    expect(LaneView.safeParse(view).success).toBe(true);
    expect(LaneView.safeParse({ ...view, descriptionPreview: "x".repeat(2001) }).success).toBe(false);
    expect(LaneView.safeParse({ ...view, descriptionTruncated: undefined }).success).toBe(false);
  });
});

describe("FanoutView", () => {
  it("takes a 24 000 character prompt and refuses 24 001", () => {
    const base = { id: "0123456789abcdef", createdAt: 1, laneIds: ["fix-it-a3f9"] };
    expect(FanoutView.safeParse({ ...base, prompt: "x".repeat(24_000) }).success).toBe(true);
    expect(FanoutView.safeParse({ ...base, prompt: "x".repeat(24_001) }).success).toBe(false);
  });
});
