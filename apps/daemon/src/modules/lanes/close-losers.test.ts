import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateBed, createCreateBed } from "./testing/create-bed.ts";
import { insertLane } from "./testing/lane-rows.ts";

let bed: CreateBed | undefined;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  bed = undefined;
});

/** Lane git calls answer from here (the fake git dir cannot run real ones), as in the archive tests. */
const make = (): CreateBed => {
  const b = (bed = createCreateBed({
    git: (real) => ({
      async run(root, args, opts) {
        if (args[0] === "status") return { stdout: Buffer.from(""), code: 0 };
        if (args[0] === "merge-base") return { stdout: Buffer.from("mb\n"), code: 0 };
        if (args[0] === "rev-list") return { stdout: Buffer.from("0\n"), code: 0 };
        if (args[0] === "diff") return { stdout: Buffer.from(""), code: 0 };
        return real.run(root, args, opts);
      },
    }),
  }));
  let n = 0;
  b.behaviour.session = async () => ({ sessionId: `s${++n}`, modelRefused: false });
  return b;
};
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );

/** A group of three active lanes (`models` of three) whose setups are done. */
async function group(b: CreateBed, archive: string | null = null) {
  if (archive !== null) {
    b.writeConfig(`archive: ${archive}\n`);
    await b.approve({ setup: undefined, archive, test: undefined });
  }
  const answer = await b.service.create(b.browser(), b.params({ models: [null, null, null] }));
  await vi.waitFor(
    () => expect(answer.laneIds.map((id) => b.view(id).state)).toEqual(["active", "active", "active"]),
    { timeout: 5000 },
  );
  await vi.waitFor(() => expect(b.calls.prompts).toHaveLength(3), { timeout: 5000 });
  return { fanoutId: answer.fanoutId as string, ids: answer.laneIds };
}
const close = (b: CreateBed, fanoutId: string, winner: string, over: { confirmTainted?: boolean } = {}) =>
  b.service.closeLosers(b.browser(), { fanoutId, winner, ...over });
const states = (b: CreateBed, ids: string[]) => ids.map((id) => b.view(id).state);

describe("lanes.closeLosers (M9R86)", () => {
  it("lists a lane whose archive throws a typed error as refused and keeps the lanes already archived (T17-1)", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    let removes = 0;
    b.behaviour.remove = () => {
      if (++removes === 2) throw new Error("remove failed");
      return { ok: true };
    };
    expect(await close(b, fanoutId, ids[0] as string)).toEqual({
      archived: [ids[1]],
      refused: [{ laneId: ids[2], reason: "busy" }],
    });
    expect(states(b, ids)).toEqual(["active", "archived", "active"]);
  });

  it("archives every lane but the winner with force, keeps their branches and leaves the winner alone", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    expect(await close(b, fanoutId, ids[1] as string)).toEqual({ archived: [ids[0], ids[2]], refused: [] });
    expect(states(b, ids)).toEqual(["archived", "active", "archived"]);
    expect(b.calls.remove.map((call) => call.force)).toEqual([true, true]);
    expect(b.calls.remove.map((call) => call.path)).toEqual(
      [ids[0], ids[2]].map((id) => b.view(id as string).worktree),
    );
    // The commits stay on the branch: no branch is deleted.
    expect(b.calls.branches).toEqual([]);
  });

  it("audits each forced loser archive and the close itself, without a path (M13)", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    await close(b, fanoutId, ids[1] as string);
    expect(b.audited.map((row) => row.reason)).toEqual([
      "lane_archived_forced",
      "lane_archived_forced",
      "lane_losers_closed",
    ]);
    expect(b.audited.at(-1)).toMatchObject({
      ownerId: "u1",
      actor: "user",
      detail: { fanoutId, winner: ids[1], archived: 2, refused: 0 },
    });
    expect(JSON.stringify(b.audited)).not.toContain(b.view(ids[0] as string).worktree);
  });

  it("lists a busy lane and leaves it alone, and archives the others", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    const busy = b.view(ids[2] as string).worktree;
    b.behaviour.activity = (folder) => ({ sessions: 1, busy: folder === busy, needsInput: false });
    expect(await close(b, fanoutId, ids[0] as string)).toEqual({
      archived: [ids[1]],
      refused: [{ laneId: ids[2], reason: "busy" }],
    });
    expect(states(b, ids)).toEqual(["active", "archived", "active"]);
  });

  it("leaves a lane whose worker releaseIdle cannot quiet alone: no work is removed under it", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    b.behaviour.releaseBusy = 1;
    const answer = await close(b, fanoutId, ids[0] as string);
    expect(answer.archived).toEqual([]);
    expect(answer.refused).toEqual([
      { laneId: ids[1], reason: "busy" },
      { laneId: ids[2], reason: "busy" },
    ]);
    expect(b.calls.remove).toEqual([]);
    expect(states(b, ids)).toEqual(["active", "active", "active"]);
  });

  it("lists a lane whose setup is still running", async () => {
    const b = make();
    b.writeConfig("setup: echo s\n");
    await b.approve({ setup: "echo s", archive: undefined, test: undefined });
    const answer = await b.service.create(b.browser(), b.params({ models: [null, null] }));
    await vi.waitFor(() => expect(b.fakes.children).toHaveLength(2), { timeout: 5000 });
    const [winner, loser] = answer.laneIds as [string, string];
    expect(await close(b, answer.fanoutId as string, winner)).toEqual({
      archived: [],
      refused: [{ laneId: loser, reason: "setup_running" }],
    });
  });

  it("asks before it runs the archive script of a lane with a tainted session, and runs it once the owner confirmed", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b, "echo bye");
    b.behaviour.sessionIds = ["s1", "s2", "s3"];
    b.behaviour.tainted.add("s3");
    const asked = await close(b, fanoutId, ids[0] as string);
    // The taint is judged per lane's folder in the real port; the bed's list is shared, so both ask.
    expect(asked.archived).toEqual([]);
    expect(asked.refused).toEqual([
      { laneId: ids[1], reason: "tainted" },
      { laneId: ids[2], reason: "tainted" },
    ]);
    expect(b.fakes.children).toHaveLength(0);
    expect(b.calls.remove).toEqual([]);
    const confirmed = close(b, fanoutId, ids[0] as string, { confirmTainted: true });
    await vi.waitFor(() => expect(b.fakes.children).toHaveLength(1), { timeout: 5000 });
    b.fakes.child(0).end({ code: 0, signal: null });
    await vi.waitFor(() => expect(b.fakes.children).toHaveLength(2), { timeout: 5000 });
    b.fakes.child(1).end({ code: 0, signal: null });
    expect(await confirmed).toEqual({ archived: [ids[1], ids[2]], refused: [] });
  });

  it("archives a lane with a tainted session when no archive script would run", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    b.behaviour.sessionIds = ["s1", "s2", "s3"];
    b.behaviour.tainted.add("s2");
    expect((await close(b, fanoutId, ids[0] as string)).refused).toEqual([]);
  });

  it("answers bad_request for a winner outside the group, not_found for another owner's or a missing group, read_only", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    expect(await codeOf(close(b, fanoutId, "other-0001"))).toBe("bad_request");
    expect(
      await codeOf(
        b.service.closeLosers({ ...b.browser(), userId: "u2" }, { fanoutId, winner: ids[0] as string }),
      ),
    ).toBe("not_found");
    expect(await codeOf(close(b, "2222222222222222", ids[0] as string))).toBe("not_found");
    expect(states(b, ids)).toEqual(["active", "active", "active"]);
    expect(b.calls.remove).toEqual([]);
  });

  it("serialises two closes of one group: the second sees the first's result and archives no winner", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    const [a, bb, c] = ids as [string, string, string];
    const first = close(b, fanoutId, a);
    const second = close(b, fanoutId, bb);
    expect(await first).toEqual({ archived: [bb, c], refused: [] });
    expect(await codeOf(second)).toBe("bad_request");
    expect(states(b, ids)).toEqual(["active", "archived", "archived"]);
  });

  it("answers not_found, whatever the winner, to a caller who does not own the group", async () => {
    const b = make();
    const { fanoutId, ids } = await group(b);
    const stranger = { ...b.browser(), userId: "u2" };
    for (const winner of [ids[0] as string, "other-0001"])
      expect(await codeOf(b.service.closeLosers(stranger, { fanoutId, winner }))).toBe("not_found");
    expect(states(b, ids)).toEqual(["active", "active", "active"]);
  });

  it("answers read_only on a read-only database", async () => {
    const b = (bed = createCreateBed({ readOnly: true }));
    b.db.run(
      "INSERT INTO lane_fanouts (id, owner_id, prompt, created_at) VALUES ('1111111111111111', 'u1', 'go', 1)",
    );
    const winner = insertLane(b.db);
    const loser = insertLane(b.db);
    b.db.run("UPDATE lanes SET fanout_id = '1111111111111111', fanout_slot = 0 WHERE id = $id", {
      id: winner.id,
    });
    b.db.run("UPDATE lanes SET fanout_id = '1111111111111111', fanout_slot = 1 WHERE id = $id", {
      id: loser.id,
    });
    expect(await codeOf(close(b, "1111111111111111", winner.id))).toBe("read_only");
  });
});
