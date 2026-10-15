import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taintedIn } from "./run-script.ts";
import { type CreateBed, createCreateBed } from "./testing/create-bed.ts";
import { insertLane } from "./testing/lane-rows.ts";

let bed: CreateBed | undefined;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  bed = undefined;
});
const make = (options: Parameters<typeof createCreateBed>[0] = {}): CreateBed =>
  (bed = createCreateBed(options));
const active = (b: CreateBed, id: string) =>
  vi.waitFor(() => expect(b.view(id).state).toBe("active"), { timeout: 5000 });
const settled = (b: CreateBed, id: string) =>
  vi.waitFor(() => expect(b.view(id).setup.state).not.toMatch(/queued|running/), { timeout: 5000 });
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );

/** An active lane whose project has an approved test script. */
async function laneWithTest(b: CreateBed): Promise<string> {
  b.writeConfig("test: echo ok\n");
  await b.approve({ setup: undefined, archive: undefined, test: "echo ok" });
  const id = await b.create();
  await active(b, id);
  await settled(b, id);
  return id;
}

describe("taintedIn", () => {
  it("counts a tainted session that was archived, and fails closed without ports", () => {
    const policy = {
      sessionPolicy: (_o: string, id: string) => ({ taint: { tainted: id === "old" } }) as never,
    };
    const lane = { ownerId: "u1", worktree: "/wt/a" };
    const ids = (list: string[]) => ({ sessionIdsIn: () => list });
    expect(
      taintedIn(
        () => ids(["old", "new"]),
        () => policy,
      )(lane),
    ).toBe(true);
    expect(
      taintedIn(
        () => ids(["new"]),
        () => policy,
      )(lane),
    ).toBe(false);
    expect(
      taintedIn(
        () => undefined,
        () => policy,
      )(lane),
    ).toBe(true);
    expect(
      taintedIn(
        () => ids([]),
        () => undefined,
      )(lane),
    ).toBe(true);
  });
});

describe("lanes.runScript", () => {
  it("answers not_active for a lane that is archived or failed, and the runner never runs", async () => {
    const b = make();
    const archived = insertLane(b.db, { projectRoot: b.gb.root });
    const failed = insertLane(b.db, { projectRoot: b.gb.root });
    b.db.run("UPDATE lanes SET state = 'archived', archived_at = 5 WHERE id = $id", { id: archived.id });
    b.db.run("UPDATE lanes SET state = 'failed', failed_reason = 'git' WHERE id = $id", { id: failed.id });
    for (const id of [archived.id, failed.id])
      expect(await b.service.runScript(b.browser(), { laneId: id, kind: "test" })).toEqual({
        ok: false,
        reason: "not_active",
      });
    expect(b.fakes.children).toHaveLength(0);
  });

  it("answers not_found for another owner's lane and read_only on a read-only database", async () => {
    const b = make();
    const id = await laneWithTest(b);
    expect(
      await codeOf(b.service.runScript({ ...b.browser(), userId: "u2" }, { laneId: id, kind: "test" })),
    ).toBe("not_found");
    const ro = make({ readOnly: true });
    const other = insertLane(ro.db);
    expect(await codeOf(ro.service.runScript(ro.browser(), { laneId: other.id, kind: "test" }))).toBe(
      "read_only",
    );
  });

  it("answers tainted with the runner never called, and runs on confirmTainted: true", async () => {
    const b = make();
    const id = await laneWithTest(b);
    b.behaviour.tainted.add("sess-1");
    const before = b.fakes.children.length;
    expect(await b.service.runScript(b.browser(), { laneId: id, kind: "test" })).toEqual({
      ok: false,
      reason: "tainted",
    });
    await expect(
      b.service.runScript(b.browser(), { laneId: id, kind: "test", confirmTainted: false }),
    ).resolves.toEqual({ ok: false, reason: "tainted" });
    expect(b.fakes.children).toHaveLength(before);
    expect(
      await b.service.runScript(b.browser(), { laneId: id, kind: "test", confirmTainted: true }),
    ).toEqual({ ok: true });
    expect(b.fakes.children).toHaveLength(before + 1);
    expect(b.fakes.child(before).cwd).toBe(b.view(id).worktree);
  });

  it("passes the runner's own refusals through", async () => {
    const b = make();
    const id = await laneWithTest(b);
    expect(await b.service.runScript(b.browser(), { laneId: id, kind: "setup" })).toEqual({
      ok: false,
      reason: "none",
    });
    expect(await b.service.runScript(b.browser(), { laneId: id, kind: "test" })).toEqual({ ok: true });
    expect(await b.service.runScript(b.browser(), { laneId: id, kind: "test" })).toEqual({
      ok: false,
      reason: "running",
    });
  });

  it("runs the lane read from the store: the worktree is the stored one", async () => {
    const b = make();
    const id = await laneWithTest(b);
    await b.service.runScript(b.browser(), { laneId: id, kind: "test" });
    const spawned = b.fakes.children.at(-1);
    expect(spawned?.cwd).toBe(
      b.db.get<{ worktree: string }>("SELECT worktree FROM lanes WHERE id = $id", { id })?.worktree,
    );
  });
});
