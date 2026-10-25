import { existsSync } from "node:fs";
import { join } from "node:path";
import { LANE_LIMITS, PapError, type ResultOf } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { lanesArchiveRpc } from "./rpc-archive.ts";
import { type CreateBed, createCreateBed } from "./testing/create-bed.ts";
import { insertLane } from "./testing/lane-rows.ts";

let bed: CreateBed | undefined;
let dirty = false;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  [bed, dirty] = [undefined, false];
});

/** Lane git calls answer from here (the fake git dir cannot run real ones); the checkpoint ref calls run for real and are traced. */
const make = (): CreateBed =>
  (bed = createCreateBed({
    git: (real, order) => ({
      async run(root, args, opts) {
        if (args[0] === "status")
          return { stdout: Buffer.from(dirty ? "1 .M N... 100644 100644 100644 a b f\0" : ""), code: 0 };
        if (args[0] === "merge-base") return { stdout: Buffer.from("mb\n"), code: 0 };
        if (args[0] === "rev-list") return { stdout: Buffer.from("0\n"), code: 0 };
        if (args[0] === "diff") return { stdout: Buffer.from(""), code: 0 };
        if (args[0] === "for-each-ref" || args[0] === "update-ref") order.push(`git:${args[0]}`);
        return real.run(root, args, opts);
      },
    }),
  }));

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );
const settledSetup = (b: CreateBed, id: string) =>
  vi.waitFor(() => expect(b.view(id).setup.state).not.toMatch(/queued|running/), { timeout: 5000 });

/** An active lane in a project with an approved archive script. */
async function lane(b: CreateBed, archive: string | null = "echo bye"): Promise<string> {
  if (archive !== null) {
    b.writeConfig(`archive: ${archive}\n`);
    await b.approve({ setup: undefined, archive, test: undefined });
  }
  const id = await b.create();
  // `active` alone is too early: the setup step still holds the lane's place in the runner.
  await b.service.settled();
  return id;
}
const params = (
  laneId: string,
  over: Partial<{ force: boolean; deleteBranch: boolean; confirmTainted: boolean }> = {},
) => ({
  laneId,
  force: false,
  deleteBranch: false,
  ...over,
});
const archive = (b: CreateBed, laneId: string, over = {}) =>
  b.service.archive(b.browser(), params(laneId, over));
/** Starts an archive and stops it when its script is running (child `at`). */
async function archiving(b: CreateBed, id: string, at: number, over = {}) {
  const run = archive(b, id, over);
  await vi.waitFor(() => expect(b.fakes.children).toHaveLength(at + 1), { timeout: 5000 });
  return { run };
}
const finish = (b: CreateBed, at: number, code = 0) => b.fakes.child(at).end({ code, signal: null });
const state = (b: CreateBed, id: string) => b.view(id).state;
const unchanged = (b: CreateBed, id: string) => {
  expect(state(b, id)).toBe("active");
  expect(b.order).not.toContain("remove");
  expect(b.order).not.toContain("releaseIn");
  expect(b.fakes.children).toHaveLength(0);
  expect(b.service.paths.closed(b.view(id).worktree)).toBeNull();
};

describe("lanes.archive: refusals before anything changes", () => {
  it("answers busy for a busy session", async () => {
    const b = make();
    const id = await lane(b);
    b.behaviour.activity = () => ({ sessions: 1, busy: true, needsInput: false });
    expect(await archive(b, id)).toEqual({ ok: false, reason: "busy", logTail: null });
    unchanged(b, id);
  });

  it("answers busy for a terminal running in the worktree", async () => {
    const b = make();
    const id = await lane(b);
    b.behaviour.terminals = 1;
    expect(await archive(b, id)).toEqual({ ok: false, reason: "busy", logTail: null });
    unchanged(b, id);
  });

  it("answers busy for a test script running, and setup_running while the setup runs", async () => {
    const b = make();
    b.writeConfig("setup: echo s\ntest: echo t\narchive: echo a\n");
    await b.approve({ setup: "echo s", test: "echo t", archive: "echo a" });
    const id = await b.create();
    await vi.waitFor(() => expect(b.fakes.children).toHaveLength(1), { timeout: 5000 });
    expect(await archive(b, id)).toEqual({ ok: false, reason: "setup_running", logTail: null });
    finish(b, 0);
    await settledSetup(b, id);
    expect(await b.service.runScript(b.browser(), { laneId: id, kind: "test" })).toEqual({ ok: true });
    expect(await archive(b, id)).toEqual({ ok: false, reason: "busy", logTail: null });
    expect(state(b, id)).toBe("active");
    expect(b.order).not.toContain("remove");
  });

  it("answers dirty before the archive script runs, and continues with force", async () => {
    const b = make();
    const id = await lane(b);
    dirty = true;
    expect(await archive(b, id)).toEqual({ ok: false, reason: "dirty", logTail: null });
    unchanged(b, id);
    const { run } = await archiving(b, id, 0, { force: true });
    finish(b, 0);
    expect(await run).toEqual({ ok: true, branchDeleted: null });
    expect(b.calls.remove).toEqual([{ path: b.view(id).worktree, force: true }]);
  });

  it("answers tainted when an archive script will run and the owner did not confirm, and continues with it", async () => {
    const b = make();
    const id = await lane(b);
    b.behaviour.tainted.add("sess-1");
    expect(await archive(b, id)).toEqual({ ok: false, reason: "tainted", logTail: null });
    unchanged(b, id);
    const { run } = await archiving(b, id, 0, { confirmTainted: true });
    finish(b, 0);
    expect(await run).toMatchObject({ ok: true });
  });

  it("does not ask for the tainted confirmation when there is no archive script to run", async () => {
    const b = make();
    const id = await lane(b, null);
    b.behaviour.tainted.add("sess-1");
    expect(await archive(b, id)).toEqual({ ok: true, branchDeleted: null });
    expect(b.fakes.children).toHaveLength(0);
  });

  it("answers not_found for another owner's lane and read_only on a read-only database", async () => {
    const b = make();
    const id = await lane(b);
    expect(await codeOf(b.service.archive({ ...b.browser(), userId: "u2" }, params(id)))).toBe("not_found");
    unchanged(b, id);
    const ro = (bed = createCreateBed({ readOnly: true }));
    const other = insertLane(ro.db);
    expect(await codeOf(ro.service.archive(ro.browser(), params(other.id)))).toBe("read_only");
  });

  it("answers busy while the lane is creating or already archiving", async () => {
    const b = make();
    const id = await lane(b);
    const { run: first } = await archiving(b, id, 0);
    expect(await archive(b, id)).toEqual({ ok: false, reason: "busy", logTail: null });
    finish(b, 0);
    await first;
    const creating = insertLane(b.db, { projectRoot: b.gb.root });
    expect(await archive(b, creating.id)).toEqual({ ok: false, reason: "busy", logTail: null });
  });
});

describe("lanes.archive: the order of M9R40", () => {
  it("archives under the lane lock in the ruled order, and ends archived with archived_at and no logs", async () => {
    const b = make();
    const id = await lane(b);
    const worktree = b.view(id).worktree;
    const mark = b.order.length;
    const seen: Array<{ step: string; state: string; closed: string | null; scripts: number }> = [];
    b.behaviour.onStep = (step) =>
      void seen.push({
        step,
        state: state(b, id),
        closed: b.service.paths.closed(worktree),
        scripts: b.fakes.children.length,
      });
    await b.clock.advance(1234);
    const { run } = await archiving(b, id, 0, { deleteBranch: true });
    // The archive script runs with the lane archiving, so prompts are refused in its folder; nothing is removed yet.
    expect(state(b, id)).toBe("archiving");
    expect(b.service.paths.closed(worktree)).toBe("archiving");
    expect(b.order.slice(mark)).not.toContain("remove");
    expect(b.fakes.child(0).cwd).toBe(worktree);
    finish(b, 0);
    expect(await run).toEqual({ ok: true, branchDeleted: true });
    expect(b.order.slice(mark)).toEqual([
      "activityIn",
      "terminals",
      "activityIn",
      "terminals",
      "releaseIn",
      "trust.clear",
      "remove",
      "git:for-each-ref",
      "deleteBranch",
      "archiveIn",
    ]);
    // The worktree is removed only after the script ended, with the lane still archiving.
    expect(seen).toEqual([
      { step: "releaseIn", state: "archiving", closed: "archiving", scripts: 1 },
      { step: "remove", state: "archiving", closed: "archiving", scripts: 1 },
    ]);
    expect(b.calls.trust).toEqual([{ ownerId: "u1", folder: worktree }]);
    expect(b.calls.branches[0]).toEqual({ repoRoot: expect.any(String), branch: b.view(id).branch });
    expect(existsSync(join(b.home, "lanes", id))).toBe(false);
    const row = b.db.get<{ state: string; archived_at: number }>(
      "SELECT state, archived_at FROM lanes WHERE id = $id",
      { id },
    );
    expect(row).toEqual({ state: "archived", archived_at: b.clock.now() });
    expect(b.service.paths.closed(worktree)).toBe("archived");
    expect(b.service.listArchived(b.browser(), {}).lanes.map((l) => l.id)).toEqual([id]);
    expect(b.service.listArchived(b.browser(), {}).lanes[0]?.branch).toBe(b.view(id).branch);
  });

  it("deletes with -d even when forced, and reports a branch that would not go as branchDeleted: false", async () => {
    const b = make();
    const id = await lane(b, null);
    dirty = true;
    b.behaviour.deleteBranch = false;
    expect(await archive(b, id, { force: true, deleteBranch: true })).toEqual({
      ok: true,
      branchDeleted: false,
    });
    expect(Object.keys(b.calls.branches[0] ?? {})).not.toContain("force");
    expect(state(b, id)).toBe("archived");
  });

  it("deletes every checkpoint ref of the lane, and no other", async () => {
    const b = make();
    const id = await lane(b, null);
    const head = b.gb.git(b.gb.root, "rev-parse", "HEAD").trim();
    const refs = [`e/aaaaaaaaaaaaaaaa`, "root", "undo"].map((tail) => `refs/pap/checkpoints/${id}/${tail}`);
    const other = "refs/pap/checkpoints/other-lane-1234/root";
    for (const ref of [...refs, other]) b.gb.git(b.gb.root, "update-ref", ref, head);
    expect(await archive(b, id)).toEqual({ ok: true, branchDeleted: null });
    const left = b.gb.git(b.gb.root, "for-each-ref", "--format=%(refname)", "refs/pap/checkpoints").trim();
    expect(left.split("\n")).toEqual([other]);
  });
});

describe("lanes.archive: a worker that is not quiet (I1)", () => {
  it.each(["an open dialog", "a queued message", "a command in flight"])(
    "refuses busy and removes nothing with %s",
    async () => {
      const b = make();
      const id = await lane(b, null);
      b.behaviour.releaseBusy = 1;
      expect(await archive(b, id)).toEqual({ ok: false, reason: "busy", logTail: null });
      expect(state(b, id)).toBe("active");
      expect(b.service.paths.closed(b.view(id).worktree)).toBeNull();
      expect(b.order).not.toContain("remove");
      expect(b.order).not.toContain("archiveIn");
      expect(b.calls.remove).toEqual([]);
    },
  );
});

describe("lanes.archive: the archive script", () => {
  it("answers script_failed with the last 4 KiB of the log, and puts the lane back to active", async () => {
    const b = make();
    const id = await lane(b);
    const { run } = await archiving(b, id, 0);
    b.fakes.child(0).emit(`${"x".repeat(6000)}the-end`);
    finish(b, 0, 3);
    const answer = (await run) as Extract<ResultOf<"lanes.archive">, { ok: false }>;
    expect(answer.reason).toBe("script_failed");
    expect(answer.logTail?.length).toBe(LANE_LIMITS.logTail);
    expect(answer.logTail?.endsWith("the-end")).toBe(true);
    expect(state(b, id)).toBe("active");
    expect(b.service.paths.closed(b.view(id).worktree)).toBeNull();
    expect(b.order).not.toContain("remove");
  });

  it("continues past a failing archive script with force", async () => {
    const b = make();
    const id = await lane(b);
    const { run } = await archiving(b, id, 0, { force: true });
    finish(b, 0, 1);
    expect(await run).toEqual({ ok: true, branchDeleted: null });
    expect(state(b, id)).toBe("archived");
  });

  it("stops at a stop: the script is interrupted, the call answers script_failed and the lane is active", async () => {
    const b = make();
    const id = await lane(b);
    const { run } = await archiving(b, id, 0);
    const stopping = Promise.all([b.runner.shutdown(), b.service.shutdown()]);
    b.fakes.child(0).end({ code: null, signal: "SIGTERM" });
    await stopping;
    expect(await run).toMatchObject({ ok: false, reason: "script_failed" });
    expect(state(b, id)).toBe("active");
    expect(await codeOf(archive(b, id))).toBe("capacity");
  });
});

describe("lanes.archive: the re-check under the lane lock", () => {
  it("answers busy and puts the lane back to active when a run started just before archiving", async () => {
    const b = make();
    const id = await lane(b);
    let asked = 0;
    // The first look (step 1) is idle; by the second (step 4, under the lock) a run has started.
    b.behaviour.activity = () => ({ sessions: 1, busy: ++asked > 1, needsInput: false });
    const { run } = await archiving(b, id, 0);
    finish(b, 0);
    expect(await run).toEqual({ ok: false, reason: "busy", logTail: null });
    expect(state(b, id)).toBe("active");
    expect(b.service.paths.closed(b.view(id).worktree)).toBeNull();
    expect(b.order).not.toContain("remove");
    expect(b.order).not.toContain("releaseIn");
  });

  it("answers dirty and goes back to active when the worktree turns out dirty at the removal; the trust entry went first, so the banner asks again (I2)", async () => {
    const b = make();
    const id = await lane(b, null);
    b.behaviour.remove = () => ({ ok: false, reason: "dirty" });
    expect(await archive(b, id)).toEqual({ ok: false, reason: "dirty", logTail: null });
    expect(state(b, id)).toBe("active");
    expect(b.order).not.toContain("archiveIn");
    expect(b.order.indexOf("trust.clear")).toBeLessThan(b.order.indexOf("remove"));
  });

  it("holds the lane lock for steps 4 to 12: a commit queued meanwhile runs after the archive", async () => {
    const b = make();
    const id = await lane(b, null);
    const ran: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    b.behaviour.onStep = (step) => {
      if (step !== "releaseIn") return;
      void b.service.laneLock(id).run("commit", async () => void ran.push(`commit after ${state(b, id)}`));
      ran.push("queued");
      release();
    };
    await archive(b, id);
    await hold;
    await vi.waitFor(() => expect(ran).toEqual(["queued", "commit after archived"]));
  });
});

describe("lanes.archive: other lane states", () => {
  it("archives a failed lane without touching a worktree", async () => {
    const b = make();
    const failed = insertLane(b.db, { projectRoot: b.gb.root });
    b.db.run("UPDATE lanes SET state = 'failed', failed_reason = 'git' WHERE id = $id", { id: failed.id });
    expect(await archive(b, failed.id)).toEqual({ ok: true, branchDeleted: null });
    expect(state(b, failed.id)).toBe("archived");
    expect(b.order).not.toContain("remove");
  });

  it("archives a failed lane whose log folder cannot be removed, and leaves branchDeleted null (T16-1)", async () => {
    const b = make();
    const failed = insertLane(b.db, { projectRoot: b.gb.root });
    b.db.run("UPDATE lanes SET state = 'failed', failed_reason = 'git' WHERE id = $id", { id: failed.id });
    vi.spyOn(b.runner, "deleteLogs").mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(await archive(b, failed.id, { deleteBranch: true })).toEqual({ ok: true, branchDeleted: null });
    expect(state(b, failed.id)).toBe("archived");
  });

  it("answers ok again for a lane that is already archived", async () => {
    const b = make();
    const id = await lane(b, null);
    await archive(b, id);
    const mark = b.order.length;
    expect(await archive(b, id)).toEqual({ ok: true, branchDeleted: null });
    expect(b.order.slice(mark)).toEqual([]);
  });
});

describe("the archive rpc", () => {
  it("refuses a caller without lanes:admin before the service is reached", async () => {
    const b = make();
    const id = await lane(b, null);
    const dispatch = createDispatcher({
      gate: { allows: () => true },
      handlers: lanesArchiveRpc(b.service) as never,
      receipts: undefined as never,
      logger: silentLogger,
    });
    const token = testCaller({ kind: "token", permissions: new Set(["lanes:read", "lanes:operate"]) });
    const ctx = { caller: token, connectionId: "c1", openSubscription: vi.fn(), closeSubscription: vi.fn() };
    const reply = await dispatch(
      {
        id: 1,
        method: "lanes.archive",
        params: { laneId: id, force: false, deleteBranch: false },
        commandId: "c-1",
      } as never,
      ctx as never,
    );
    expect(reply).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(state(b, id)).toBe("active");
  });
});
