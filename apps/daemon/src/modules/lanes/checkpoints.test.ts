import { describe, expect, it, vi } from "vitest";
import { deferred } from "./testing/create-bed.ts";
import { createCheckpointBed, LANE_ID, oid, REF } from "./testing/checkpoint-bed.ts";

const before = (bed: ReturnType<typeof createCheckpointBed>, over = {}, released = { value: false }) =>
  bed.checkpoints.beforePrompt(bed.info(over), released);
const kinds = (bed: ReturnType<typeof createCheckpointBed>) =>
  bed.notices.list(LANE_ID).map((notice) => [notice.kind, notice.count]);

describe("the lanes-side beforePrompt (M9R73)", () => {
  it("replaces e/<leaf> with the current files, after the disk floor and one capture", async () => {
    const bed = createCheckpointBed();
    bed.refs.set(REF("e/leaf1"), oid(99));
    await before(bed);
    expect(bed.refs.get(REF("e/leaf1"))).toBe(oid(1));
    expect(bed.log.filter((line) => !line.startsWith("publish"))).toEqual([
      `disk ${bed.lane.worktree}`,
      "capture-start e/leaf1",
      "capture-end 1",
      "update-ref e/leaf1",
    ]);
  });

  it("uses the root key when the session has no leaf yet", async () => {
    const bed = createCheckpointBed();
    bed.behaviour.leafId = null;
    await before(bed, { leafId: null });
    expect([...bed.refs.keys()]).toEqual([REF("root")]);
  });

  it("never replaces the lane's root ref: a second session at its start leaves it alone (final review M2)", async () => {
    const bed = createCheckpointBed();
    bed.refs.set(REF("root"), oid(99));
    bed.behaviour.leafId = null;
    await before(bed, { leafId: null, sessionId: "sess-2" });
    expect(bed.refs.get(REF("root"))).toBe(oid(99));
    expect(bed.counters.captures).toBe(0);
  });

  it("asks the sessions port whether this session is idle, counting its own waiting prompt as not busy", async () => {
    const bed = createCheckpointBed();
    await before(bed);
    expect(bed.sessions.runState).toHaveBeenCalledWith("u1", "sess-1", { ownPrompt: true });
  });

  it("never overlaps two captures of one lane", async () => {
    const bed = createCheckpointBed();
    const gate = deferred();
    let first = true;
    bed.behaviour.capture = async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
    };
    const a = before(bed, { sessionId: "sess-1" });
    const b = before(bed, { sessionId: "sess-2" });
    await vi.waitFor(() => expect(bed.counters.captures).toBe(1));
    gate.resolve();
    await Promise.all([a, b]);
    expect(bed.counters.captures).toBe(2);
    expect(bed.counters.maxActive).toBe(1);
  });

  it("answers undefined at once, calling nothing, for a session outside any lane", () => {
    const bed = createCheckpointBed();
    expect(before(bed, { cwd: "/elsewhere" })).toBeUndefined();
    expect(bed.sessions.runState).not.toHaveBeenCalled();
    expect(bed.counters.captures).toBe(0);
  });

  it("answers undefined at once for a lane that is not active, another owner's session and a read-only daemon", () => {
    const closing = createCheckpointBed({ state: "archiving" });
    expect(before(closing)).toBeUndefined();
    const bed = createCheckpointBed();
    expect(before(bed, { ownerId: "u2" })).toBeUndefined();
    expect(before(createCheckpointBed({ readOnly: true }))).toBeUndefined();
  });

  it("skips an entry id that fails EntryId, logged, without a capture", async () => {
    const bed = createCheckpointBed();
    expect(before(bed, { leafId: "not an id/../x" })).toBeUndefined();
    expect(bed.counters.captures).toBe(0);
  });

  it("leaves e/<leaf> as it was and adds checkpoint_before_late when the prompt was released during the capture", async () => {
    const bed = createCheckpointBed();
    bed.refs.set(REF("e/leaf1"), oid(99));
    const released = { value: false };
    bed.behaviour.capture = async () => {
      released.value = true;
    };
    await before(bed, {}, released);
    expect(bed.refs.get(REF("e/leaf1"))).toBe(oid(99));
    expect(bed.log).not.toContain("update-ref e/leaf1");
    expect(kinds(bed)).toEqual([["checkpoint_before_late", null]]);
  });

  it("takes no capture when the session is no longer idle by the time the lock is taken", async () => {
    const bed = createCheckpointBed();
    const hold = deferred();
    void bed.shared.lock(LANE_ID).run("commit", () => hold.promise);
    const pending = before(bed);
    bed.behaviour.idle = false;
    hold.resolve();
    await pending;
    expect(bed.counters.captures).toBe(0);
    expect(bed.counters.diskChecks).toBe(0);
  });

  it("takes no capture when the leaf moved by the time the lock is taken", async () => {
    const bed = createCheckpointBed();
    const hold = deferred();
    void bed.shared.lock(LANE_ID).run("commit", () => hold.promise);
    const pending = before(bed);
    bed.behaviour.leafId = "other";
    hold.resolve();
    await pending;
    expect(bed.counters.captures).toBe(0);
  });

  it("skips the capture and adds disk_low when the disk floor throws", async () => {
    const bed = createCheckpointBed();
    bed.behaviour.diskFloor = () => {
      throw new Error("low");
    };
    await before(bed);
    expect(bed.counters.captures).toBe(0);
    expect(kinds(bed)).toEqual([["disk_low", null]]);
  });

  it("adds large_files_skipped with the count when files were left out", async () => {
    const bed = createCheckpointBed();
    bed.behaviour.skipped = 2;
    await before(bed);
    expect(kinds(bed)).toEqual([["large_files_skipped", 2]]);
    expect(bed.refs.get(REF("e/leaf1"))).toBe(oid(1));
  });

  it("logs a failing capture and lets the prompt go: nothing is thrown, no ref is written", async () => {
    const bed = createCheckpointBed();
    bed.behaviour.capture = async () => {
      throw new Error("git failed");
    };
    await expect(before(bed)).resolves.toBeUndefined();
    expect(bed.refs.size).toBe(0);
  });
});

describe("the lanes-side afterRun (M9R73)", () => {
  it("captures at the leaf the run ended on, refreshes the facts, publishes and runs the listeners", async () => {
    const bed = createCheckpointBed();
    const heard: string[] = [];
    bed.checkpoints.onAfterRun((lane, info) => void heard.push(`${lane.id}:${info.sessionId}`));
    bed.checkpoints.afterRun(bed.info({ leafId: "leaf9" }));
    await bed.checkpoints.settled();
    expect(bed.refs.get(REF("e/leaf9"))).toBe(oid(1));
    const order = bed.log.filter((line) => !line.startsWith("disk"));
    expect(order.indexOf("update-ref e/leaf9")).toBeLessThan(order.indexOf(`facts ${LANE_ID}`));
    expect(order.indexOf(`facts ${LANE_ID}`)).toBeLessThan(order.lastIndexOf(`publish ${LANE_ID}`));
    expect(heard).toEqual([`${LANE_ID}:sess-1`]);
  });

  it("sets first_run_ended_at once, however many runs end", async () => {
    const bed = createCheckpointBed();
    bed.checkpoints.afterRun(bed.info({ leafId: "a1" }));
    bed.checkpoints.afterRun(bed.info({ leafId: "a2" }));
    await bed.checkpoints.settled();
    expect(bed.store.markFirstRunEnded).toHaveBeenCalledTimes(1);
    expect(bed.store.markFirstRunEnded).toHaveBeenCalledWith(LANE_ID, bed.clock.now());
  });

  it("calls nothing for a session outside a lane, and skips an invalid entry id yet still marks the run's end", async () => {
    const bed = createCheckpointBed();
    bed.checkpoints.afterRun(bed.info({ cwd: "/elsewhere" }));
    bed.checkpoints.afterRun(bed.info({ leafId: "bad id" }));
    await bed.checkpoints.settled();
    expect(bed.counters.captures).toBe(0);
    expect(bed.store.markFirstRunEnded).toHaveBeenCalledTimes(1);
  });

  it("adds large_files_skipped and disk_low like the before capture, and still ends the run", async () => {
    const bed = createCheckpointBed();
    bed.behaviour.skipped = 3;
    bed.checkpoints.afterRun(bed.info());
    await bed.checkpoints.settled();
    expect(kinds(bed)).toEqual([["large_files_skipped", 3]]);
    const low = createCheckpointBed();
    low.behaviour.diskFloor = () => {
      throw new Error("low");
    };
    low.checkpoints.afterRun(low.info());
    await low.checkpoints.settled();
    expect(kinds(low)).toEqual([["disk_low", null]]);
    expect(low.store.markFirstRunEnded).toHaveBeenCalledTimes(1);
  });
});
