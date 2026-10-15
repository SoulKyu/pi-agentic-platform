import { afterEach, describe, expect, it, vi } from "vitest";
import { PapError, type ReviewDoc } from "@pap/contracts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createLaneReview, type LaneReviewDeps } from "./review.ts";
import { createReviewStore } from "./review-store.ts";
import { createLanesStore } from "./store.ts";
import { createLanesBed, type LanesBed } from "./testing/bed.ts";
import { insertLane } from "./testing/lane-rows.ts";

const OID = (n: number): string => n.toString(16).padStart(40, "0");
const TREE = OID(0xabc);
const MERGE_BASE = OID(1);
const caller = testCaller({ userId: "u1" });

let bed: LanesBed;
afterEach(() => bed.dispose());

interface Setup {
  paths?: Array<{ id: string; parentId: string | null; user: boolean; preview: string }>;
  refs?: Record<string, string>;
  sessions?: string[];
  mergeBase?: GitError;
  truncated?: boolean;
}

function make(script: Setup = {}) {
  bed = createLanesBed();
  const lane = insertLane(bed.db, { id: "lane-1", ownerId: "u1", worktree: "/wt/lane-1" });
  bed.db.run("UPDATE lanes SET state = 'active', base_ref = 'refs/heads/main' WHERE id = 'lane-1'");
  insertLane(bed.db, { id: "lane-2", ownerId: "u2", worktree: "/wt/lane-2" });
  bed.db.run("UPDATE lanes SET state = 'active' WHERE id = 'lane-2'");
  const calls: string[][] = [];
  const git: GitRunner = {
    async run(_root, args) {
      calls.push([...args]);
      if (args[0] === "merge-base") {
        if (script.mergeBase) throw script.mergeBase;
        return { stdout: Buffer.from(`${MERGE_BASE}\n`), code: 0 };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
  const snapshotTree = vi.fn(async () => ({ tree: TREE, skipped: 0, left: [] }));
  const diffList = vi.fn(async () => ({
    files: [
      {
        path: "a.txt",
        oldPath: null,
        status: "M" as const,
        additions: 1,
        deletions: 0,
        binary: false,
        identity: OID(7),
      },
    ],
    truncated: script.truncated ?? false,
  }));
  const refs = new Map(Object.entries(script.refs ?? {}));
  const branchPath = vi.fn(async () => ({ leafId: null, entries: script.paths ?? [] }));
  const deps: LaneReviewDeps = {
    git,
    logger: silentLogger,
    lanes: createLanesStore(bed.db),
    reviews: createReviewStore(bed.db),
    gitDirOf: (worktree) => (worktree === lane.worktree ? "/repo/.git/worktrees/lane-1" : undefined),
    indexDir: "/idx",
    sessions: () => ({
      sessionIdsIn: (ownerId, folder) =>
        ownerId === "u1" && folder === "/wt/lane-1" ? (script.sessions ?? []) : [],
      branchPath,
    }),
    readOnly: false,
    diskFloor: () => undefined,
    ops: { snapshotTree, diffList, laneRefs: async () => refs },
  };
  return { deps, review: createLaneReview(deps), calls, snapshotTree, diffList, branchPath };
}

const chain = (ids: string[]) =>
  ids.map((id, at) => ({
    id,
    parentId: at === 0 ? null : (ids[at - 1] ?? null),
    user: id.startsWith("u"),
    preview: `ask ${id}`,
  }));
const ref = (key: string) => `refs/pap/checkpoints/lane-1/${key}`;

describe("lanes.review branch scope (M9R76)", () => {
  it("lists the merge base against the live tree, labelled with the base", async () => {
    const t = make();
    const list = await t.review.review(caller, { laneId: "lane-1", scope: { kind: "branch" } });
    expect(t.calls[0]).toEqual(["merge-base", "refs/heads/main", "HEAD"]);
    expect(t.snapshotTree).toHaveBeenCalledWith(
      expect.anything(),
      "/wt/lane-1",
      "/repo/.git/worktrees/lane-1",
      "/idx",
    );
    expect(t.diffList).toHaveBeenCalledWith(
      expect.anything(),
      "/wt/lane-1",
      "/repo/.git/worktrees/lane-1",
      MERGE_BASE,
      TREE,
      expect.anything(),
    );
    expect(list.from).toEqual({ oid: MERGE_BASE, label: "main" });
    expect(list.to).toEqual({ kind: "live", tree: TREE });
    expect(list.files).toHaveLength(1);
  });

  it("checks the disk floor before the snapshot: a full disk answers capacity, a read-only daemon read_only (M5)", async () => {
    const t = make();
    const floor = vi.fn((): undefined => undefined);
    await createLaneReview({ ...t.deps, diskFloor: floor }).review(caller, {
      laneId: "lane-1",
      scope: { kind: "branch" },
    });
    expect(floor).toHaveBeenCalledWith("/wt/lane-1");
    t.snapshotTree.mockClear();
    const full = createLaneReview({
      ...t.deps,
      diskFloor: () => {
        throw new PapError("capacity");
      },
    });
    await expect(full.review(caller, { laneId: "lane-1", scope: { kind: "branch" } })).rejects.toMatchObject({
      code: "capacity",
    });
    const ro = createLaneReview({ ...t.deps, readOnly: true });
    await expect(ro.review(caller, { laneId: "lane-1", scope: { kind: "branch" } })).rejects.toMatchObject({
      code: "read_only",
    });
    expect(t.snapshotTree).not.toHaveBeenCalled();
  });

  it("passes truncated through", async () => {
    const t = make({ truncated: true });
    const list = await t.review.review(caller, { laneId: "lane-1", scope: { kind: "branch" } });
    expect(list.truncated).toBe(true);
  });

  it("answers not_found for another owner's lane and for an unknown one", async () => {
    const t = make();
    for (const laneId of ["lane-2", "nope-00"])
      await expect(t.review.review(caller, { laneId, scope: { kind: "branch" } })).rejects.toMatchObject({
        code: "not_found",
      });
  });

  it("falls back to the stored base commit when merge-base fails because the base branch is gone (T16-1)", async () => {
    const t = make({ mergeBase: new GitError("failed") });
    const list = await t.review.review(caller, { laneId: "lane-1", scope: { kind: "branch" } });
    expect(list.from.oid).toBe(
      bed.db.get<{ oid: string }>("SELECT base_oid AS oid FROM lanes WHERE id = 'lane-1'")?.oid,
    );
  });

  it("maps a git timeout to timeout and any other failure to capacity", async () => {
    const slow = make({ mergeBase: new GitError("timeout") });
    await expect(
      slow.review.review(caller, { laneId: "lane-1", scope: { kind: "branch" } }),
    ).rejects.toMatchObject({ code: "timeout" });
    bed.dispose();
    const broken = make({ mergeBase: new GitError("too_large") });
    await expect(
      broken.review.review(caller, { laneId: "lane-1", scope: { kind: "branch" } }),
    ).rejects.toMatchObject({ code: "capacity" });
  });
});

describe("lanes.review turn scope (M9R76)", () => {
  const paths = chain(["u1", "a1", "u2", "a2"]);
  const refs = { [ref("root")]: OID(10), [ref("e/a1")]: OID(11) };

  it("lists a turn between its checkpoint commits", async () => {
    const t = make({ paths, refs, sessions: ["s1"] });
    const list = await t.review.review(caller, {
      laneId: "lane-1",
      scope: { kind: "turn", sessionId: "s1", userEntryId: "u1" },
    });
    expect(list.from.oid).toBe(OID(10));
    expect(list.to).toMatchObject({ kind: "commit", oid: OID(11) });
    expect(t.snapshotTree).not.toHaveBeenCalled();
    expect(t.diffList.mock.calls[0]?.slice(3, 5)).toEqual([OID(10), OID(11)]);
  });

  it("ends the last turn at the live files", async () => {
    const t = make({ paths, refs, sessions: ["s1"] });
    const list = await t.review.review(caller, {
      laneId: "lane-1",
      scope: { kind: "turn", sessionId: "s1", userEntryId: "u2" },
    });
    expect(list.from.oid).toBe(OID(11));
    expect(list.to).toEqual({ kind: "live", tree: TREE });
  });

  it("answers not_found for an unknown turn", async () => {
    const t = make({ paths, refs, sessions: ["s1"] });
    await expect(
      t.review.review(caller, {
        laneId: "lane-1",
        scope: { kind: "turn", sessionId: "s1", userEntryId: "a1" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers not_found for a session outside the lane", async () => {
    const t = make({ paths, refs, sessions: ["s1"] });
    await expect(
      t.review.review(caller, {
        laneId: "lane-1",
        scope: { kind: "turn", sessionId: "other", userEntryId: "u1" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(t.branchPath).not.toHaveBeenCalled();
  });
});

describe("lanes.turns (M9R77)", () => {
  it("lists newest first with a clean preview and the checkpoint commits", async () => {
    const paths = chain(["u1", "a1", "u2", "a2"]);
    paths[2] = { ...(paths[2] as (typeof paths)[number]), preview: "fix‮txt\u0000 " + "x".repeat(200) };
    const t = make({ paths, refs: { [ref("root")]: OID(10), [ref("e/a1")]: OID(11) }, sessions: ["s1"] });
    const { turns, truncated } = await t.review.turns(caller, { laneId: "lane-1", sessionId: "s1" });
    expect(truncated).toBe(false);
    expect(turns.map((turn) => [turn.index, turn.userEntryId, turn.from, turn.to])).toEqual([
      [2, "u2", OID(11), "live"],
      [1, "u1", OID(10), OID(11)],
    ]);
    expect(turns[0]?.preview.startsWith("fixtxt ")).toBe(true);
    expect(turns[0]?.preview.length).toBe(120);
  });

  it("cuts at 500 turns and says so", async () => {
    const ids = Array.from({ length: 501 }, (_, n) => `u${n}`);
    const t = make({ paths: chain(ids), sessions: ["s1"] });
    const { turns, truncated } = await t.review.turns(caller, { laneId: "lane-1", sessionId: "s1" });
    expect(turns).toHaveLength(500);
    expect(turns[0]?.index).toBe(501);
    expect(truncated).toBe(true);
  });

  it("answers not_found for a session outside the lane", async () => {
    const t = make({ sessions: ["s1"] });
    await expect(t.review.turns(caller, { laneId: "lane-1", sessionId: "zz" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("lanes.reviewState (M9R78)", () => {
  const doc: ReviewDoc = { seen: [{ path: "a.txt", identity: OID(7) }], comments: [] };

  it("starts empty at revision 0, then sets and reads back", async () => {
    const t = make();
    expect(t.review.stateGet(caller, "lane-1")).toEqual({ doc: { seen: [], comments: [] }, revision: 0 });
    expect(t.review.stateSet(caller, { laneId: "lane-1", doc, baseRevision: 0 })).toEqual({ revision: 1 });
    expect(t.review.stateGet(caller, "lane-1")).toEqual({ doc, revision: 1 });
  });

  it("answers conflict on a stale revision", () => {
    const t = make();
    t.review.stateSet(caller, { laneId: "lane-1", doc, baseRevision: 0 });
    expect(() => t.review.stateSet(caller, { laneId: "lane-1", doc, baseRevision: 0 })).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
  });

  it("answers payload_too_large past 1 MiB", () => {
    const t = make();
    const big: ReviewDoc = {
      seen: [],
      comments: [
        {
          id: "c",
          path: "a",
          side: "after",
          line: 1,
          excerpt: "x".repeat(1_048_576),
          body: "b",
          createdAt: 1,
          sentAt: null,
          resolvedAt: null,
        },
      ],
    };
    expect(() => t.review.stateSet(caller, { laneId: "lane-1", doc: big, baseRevision: 0 })).toThrow(
      expect.objectContaining({ code: "payload_too_large" }),
    );
  });

  it("answers not_found for another owner, and keeps the row of an archived lane", () => {
    const t = make();
    expect(() => t.review.stateGet(caller, "lane-2")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => t.review.stateSet(caller, { laneId: "lane-2", doc, baseRevision: 0 })).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    t.review.stateSet(caller, { laneId: "lane-1", doc, baseRevision: 0 });
    bed.db.run("UPDATE lanes SET state = 'archived', archived_at = 5 WHERE id = 'lane-1'");
    expect(t.review.stateGet(caller, "lane-1").revision).toBe(1);
  });

  it("refuses a write in read-only mode", () => {
    const t = make();
    const ro = createLaneReview({ ...t.deps, readOnly: true });
    expect(() => ro.stateSet(caller, { laneId: "lane-1", doc, baseRevision: 0 })).toThrow(
      expect.objectContaining({ code: "read_only" }),
    );
  });
});
