import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { deferred } from "./testing/create-bed.ts";
import { createCheckpointBed, LANE_ID, oid, REF } from "./testing/checkpoint-bed.ts";

const BRANCH = [
  { id: "u1", parentId: null, user: true, preview: "first" },
  { id: "a1", parentId: "u1", user: false, preview: "" },
  { id: "u2", parentId: "a1", user: true, preview: "second" },
  { id: "a2", parentId: "u2", user: false, preview: "" },
];

function bed() {
  const b = createCheckpointBed();
  b.behaviour.branch = BRANCH;
  b.behaviour.leafId = "a2";
  b.refs.set(REF("e/a1"), oid(71));
  b.refs.set(REF("e/a2"), oid(72));
  b.behaviour.treeOfCommit = () => "target-tree";
  b.behaviour.tree = (n) => (n === 1 ? "current-tree" : "target-tree");
  return b;
}
const toSession = { laneId: LANE_ID, sessionId: "sess-1" } as const;
const run = (b: ReturnType<typeof bed>, params: Parameters<typeof b.restorer.restore>[1] = toSession) =>
  b.restorer.restore(testCaller(), params);
const code = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "ok",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

describe("lanes.restore (M9R75)", () => {
  it("captures undo, restores the target, then refreshes the facts, in that order", async () => {
    const b = bed();
    expect(await run(b)).toEqual({ ok: true, changed: true, left: [], leftTotal: 0 });
    expect(b.log.filter((line) => !line.startsWith("disk") && !line.startsWith("publish"))).toEqual([
      "capture-start undo",
      "capture-end 1",
      "update-ref undo",
      `restore ${oid(72)} undo=${oid(1)}`,
      `facts ${LANE_ID}`,
    ]);
    expect(b.refs.get(REF("undo"))).toBe(oid(1));
    expect(b.log).toContain(`publish ${LANE_ID}`);
  });

  it.each([
    ["a running or starting session", (b: ReturnType<typeof bed>) => (b.behaviour.busy = true)],
    ["a lane script", (b: ReturnType<typeof bed>) => (b.behaviour.script = "running")],
  ])("is refused busy under %s, and captures nothing", async (_name, setup) => {
    const b = bed();
    setup(b);
    expect(await run(b)).toEqual({ ok: false, reason: "busy" });
    expect(b.counters.captures).toBe(0);
    expect(b.counters.restores).toBe(0);
  });

  it("is refused busy when a run started between the first check and the lock", async () => {
    const b = bed();
    const hold = deferred();
    void b.shared.lock(LANE_ID).run("commit", () => hold.promise);
    const pending = run(b);
    await Promise.resolve();
    b.behaviour.busy = true;
    hold.resolve();
    expect(await pending).toEqual({ ok: false, reason: "busy" });
    expect(b.counters.captures).toBe(0);
    expect(b.counters.restores).toBe(0);
  });

  it("takes the lane lock: nothing is captured while a commit holds it", async () => {
    const b = bed();
    const hold = deferred();
    void b.shared.lock(LANE_ID).run("commit", () => hold.promise);
    const pending = run(b);
    await Promise.resolve();
    expect(b.counters.captures).toBe(0);
    hold.resolve();
    await pending;
    expect(b.counters.captures).toBe(1);
  });

  it("answers no_checkpoint when the branch has no target, or there is no undo", async () => {
    const b = bed();
    b.refs.clear();
    expect(await run(b)).toEqual({ ok: false, reason: "no_checkpoint" });
    expect(await run(b, { laneId: LANE_ID, undo: true })).toEqual({ ok: false, reason: "no_checkpoint" });
    expect(b.counters.captures).toBe(0);
  });

  it("a second restore whose target equals the current files is a no-op and keeps the first undo", async () => {
    const b = bed();
    expect(await run(b)).toMatchObject({ ok: true, changed: true });
    expect(await run(b)).toEqual({ ok: true, changed: false });
    expect(b.counters.restores).toBe(1);
    expect(b.refs.get(REF("undo"))).toBe(oid(1));
  });

  it("undo is a swap: the current files go to undo, the old undo is applied, and Undo of Undo comes back", async () => {
    const b = bed();
    b.refs.set(REF("undo"), oid(50));
    expect(await run(b, { laneId: LANE_ID, undo: true })).toMatchObject({ ok: true, changed: true });
    expect(b.refs.get(REF("undo"))).toBe(oid(1));
    expect(b.log).toContain(`restore ${oid(50)} undo=${oid(1)}`);
    // The files now equal the old undo: a repeat finds nothing to do on the same target.
    b.behaviour.tree = () => "target-tree";
    expect(await run(b, { laneId: LANE_ID, undo: true })).toEqual({ ok: true, changed: false });
    expect(b.counters.restores).toBe(1);
    expect(b.refs.get(REF("undo"))).toBe(oid(1));
  });

  it("answers another owner's lane, a session of another owner and a session outside the lane not_found", async () => {
    const b = bed();
    expect(await code(b.restorer.restore(testCaller({ userId: "u2" }), toSession))).toBe("not_found");
    b.behaviour.ownSessions = ["sess-2"];
    expect(await code(run(b))).toBe("not_found");
    expect(await code(run(b, { laneId: "other-0001", sessionId: "sess-2" }))).toBe("not_found");
    expect(b.counters.captures).toBe(0);
  });

  it("tells the owner what a restore left: up to 50 paths with their reason, and the total", async () => {
    const b = bed();
    b.behaviour.restore = async () => ({
      removed: 0,
      left: Array.from({ length: 60 }, (_, n) => ({
        path: Buffer.from(`big${n}.bin`),
        reason: "large" as const,
      })),
    });
    const answer = await run(b);
    expect(answer).toMatchObject({ ok: true, changed: true, leftTotal: 60 });
    const left = (answer as { left: Array<{ path: string; reason: string }> }).left;
    expect(left).toHaveLength(50);
    expect(left[0]).toEqual({ path: "big0.bin", reason: "large" });
  });

  it("answers failed when git fails, and still refreshes the facts of a half-done restore", async () => {
    const b = bed();
    b.behaviour.restore = async () => {
      throw new Error("git said no");
    };
    expect(await run(b)).toEqual({ ok: false, reason: "failed" });
    expect(b.log).toContain(`facts ${LANE_ID}`);
  });

  it("answers failed in a read-only daemon, without a capture", async () => {
    const b = createCheckpointBed({ readOnly: true });
    b.behaviour.branch = BRANCH;
    b.refs.set(REF("e/a2"), oid(72));
    expect(await b.restorer.restore(testCaller(), toSession)).toEqual({ ok: false, reason: "failed" });
    expect(b.counters.captures).toBe(0);
  });
});

describe("lanes.checkpointStatus (M9R74)", () => {
  const status = (b: ReturnType<typeof bed>, sessionId = "sess-1") =>
    b.restorer.checkpointStatus(testCaller(), { laneId: LANE_ID, sessionId });

  it("names the target, says whether the files differ from it and whether an undo exists", async () => {
    const b = bed();
    b.refs.delete(REF("e/a2"));
    b.behaviour.treeOfCommit = () => "different";
    expect(await status(b)).toEqual({
      target: { entryId: "a1", turn: 1 },
      exact: false,
      differs: true,
      undoAvailable: false,
    });
    b.refs.set(REF("undo"), oid(3));
    await b.clock.advance(2_001);
    b.behaviour.treeOfCommit = () => "target-tree";
    expect(await status(b)).toMatchObject({ differs: false, undoAvailable: true });
  });

  it("memoises the snapshot of the lane for 2 seconds", async () => {
    const b = bed();
    await status(b);
    await status(b);
    expect(b.counters.snapshots).toBe(1);
    await b.clock.advance(2_001);
    await status(b);
    expect(b.counters.snapshots).toBe(2);
  });

  it("checks the disk floor before a snapshot, not for a memoised one; a full disk answers its error, a read-only daemon read_only (M5)", async () => {
    const b = bed();
    await status(b);
    await status(b);
    expect(b.counters.diskChecks).toBe(1);
    const full = bed();
    full.behaviour.diskFloor = () => {
      throw new PapError("disk_low");
    };
    expect(await code(status(full))).toBe("disk_low");
    expect(full.counters.snapshots).toBe(0);
    const ro = createCheckpointBed({ readOnly: true });
    ro.behaviour.branch = BRANCH;
    ro.refs.set(REF("e/a2"), oid(72));
    expect(
      await code(ro.restorer.checkpointStatus(testCaller(), { laneId: LANE_ID, sessionId: "sess-1" })),
    ).toBe("read_only");
    expect(ro.counters.snapshots).toBe(0);
  });

  it("has no target when the branch has no checkpoint", async () => {
    const b = bed();
    b.refs.clear();
    expect(await status(b)).toEqual({ target: null, exact: false, differs: false, undoAvailable: false });
    expect(b.counters.snapshots).toBe(0);
  });

  it("answers not_found for a session outside the lane or another owner's lane", async () => {
    const b = bed();
    b.behaviour.ownSessions = [];
    expect(await code(status(b))).toBe("not_found");
    expect(
      await code(
        b.restorer.checkpointStatus(testCaller({ userId: "u2" }), { laneId: LANE_ID, sessionId: "sess-1" }),
      ),
    ).toBe("not_found");
  });
});
