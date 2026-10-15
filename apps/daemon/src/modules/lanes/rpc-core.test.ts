import { LANE_LIMITS, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLEMENTED, lanesCoreRpc } from "./rpc-core.ts";
import { type CreateBed, createCreateBed } from "./testing/create-bed.ts";
import { insertLane } from "./testing/lane-rows.ts";

let bed: CreateBed | undefined;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  bed = undefined;
});
const make = (): CreateBed => (bed = createCreateBed());
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );

const ctxOf = (b: CreateBed) => {
  const opened: Array<[string, string, unknown]> = [];
  return {
    opened,
    ctx: {
      caller: b.browser(),
      openSubscription: (stream: string, key: string, after: unknown) => {
        opened.push([stream, key, after]);
        return "sub-1";
      },
    } as never,
  };
};

describe("the lanes core handlers", () => {
  it("declares the four methods it serves", () => {
    expect([...IMPLEMENTED].sort()).toEqual(
      ["lanes.create", "lanes.listArchived", "lanes.newSession", "subscribe.lane"].sort(),
    );
  });

  it("opens the lane stream on the caller's own key, never a param", async () => {
    const b = make();
    const rpc = lanesCoreRpc(b.service);
    const { ctx, opened } = ctxOf(b);
    await expect(rpc["subscribe.lane"]({ after: { epoch: "e", seq: 3 } }, ctx)).resolves.toEqual({
      sub: "sub-1",
    });
    expect(opened).toEqual([["lane", "u1", { epoch: "e", seq: 3 }]]);
  });

  it("hands lanes.create to the service and answers its ids", async () => {
    const b = make();
    const rpc = lanesCoreRpc(b.service);
    const { ctx } = ctxOf(b);
    const answer = await rpc["lanes.create"](b.params(), ctx);
    expect(answer.laneIds).toHaveLength(1);
    expect(answer.fanoutId).toBeNull();
  });
});

describe("lanes.newSession", () => {
  it("opens a session in the worktree with the lane's model and no prompt, and makes it the primary one", async () => {
    const b = make();
    const model = { provider: "p", modelId: "m" };
    const id = await b.create({ models: [model] });
    await b.service.settled();
    b.db.run("UPDATE lanes SET primary_session_id = NULL WHERE id = $id", { id });
    b.behaviour.session = async () => ({ sessionId: "sess-2", modelRefused: false });
    b.calls.sessions.length = 0;
    await expect(b.service.newSession(b.browser(), id)).resolves.toEqual({ sessionId: "sess-2" });
    expect(b.calls.sessions).toEqual([{ caller: expect.anything(), worktree: b.view(id).worktree, model }]);
    expect(b.calls.prompts).toHaveLength(1);
    expect(b.view(id).primarySessionId).toBe("sess-2");
  });

  it("keeps the existing primary session", async () => {
    const b = make();
    const id = await b.create();
    await b.service.settled();
    b.behaviour.session = async () => ({ sessionId: "sess-2", modelRefused: true });
    await b.service.newSession(b.browser(), id);
    expect(b.view(id).primarySessionId).toBe("sess-1");
    expect(b.view(id).notices.map((notice) => notice.kind)).toEqual(["model_refused"]);
  });

  it("answers not_found for another owner's lane and conflict for a lane that is not active", async () => {
    const b = make();
    const id = await b.create();
    await b.service.settled();
    expect(await codeOf(b.service.newSession({ ...b.browser(), userId: "u2" }, id))).toBe("not_found");
    expect(await codeOf(b.service.newSession(b.browser(), "ghost-0001"))).toBe("not_found");
    for (const state of ["creating", "archiving", "archived", "failed"]) {
      b.db.run("UPDATE lanes SET state = $state WHERE id = $id", { state, id });
      expect(await codeOf(b.service.newSession(b.browser(), id)), state).toBe("conflict");
    }
  });

  it("lets the session's refusal through", async () => {
    const b = make();
    const id = await b.create();
    await b.service.settled();
    b.behaviour.session = () => Promise.reject(new PapError("capacity"));
    expect(await codeOf(b.service.newSession(b.browser(), id))).toBe("capacity");
  });

  it("refuses on a read-only database", async () => {
    const b = (bed = createCreateBed({ readOnly: true }));
    insertLane(b.db, { id: "ro-0001", worktree: "/w/ro" });
    b.db.run("UPDATE lanes SET state = 'active' WHERE id = 'ro-0001'");
    expect(await codeOf(b.service.newSession(b.browser(), "ro-0001"))).toBe("read_only");
  });
});

describe("lanes.listArchived", () => {
  const archive = (b: CreateBed, count: number, owner = "u1") => {
    for (let n = 0; n < count; n++) {
      const id = `arch-${String(n).padStart(4, "0")}`;
      insertLane(b.db, { id, ownerId: owner, worktree: `/w/${owner}/${n}` });
      b.db.run("UPDATE lanes SET state = 'archived', archived_at = $at WHERE id = $id", {
        id,
        at: 1000 + (n % 5),
      });
    }
  };

  it("pages archived lanes newest first by (archived_at, id), one page of 100", async () => {
    const b = make();
    archive(b, 101);
    const first = await b.service.listArchived(b.browser(), {});
    expect(LANE_LIMITS.archivedPage).toBe(100);
    expect(first.lanes).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const keys = first.lanes.map((lane) => [lane.archivedAt, lane.id] as const);
    expect(keys).toEqual(
      [...keys].sort((x, y) => (y[0] as number) - (x[0] as number) || (x[1] < y[1] ? 1 : -1)),
    );
    const last = first.lanes.at(-1);
    const second = await b.service.listArchived(b.browser(), {
      before: { archivedAt: last?.archivedAt as number, id: last?.id as string },
    });
    expect(second.lanes).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.lanes, ...second.lanes].map((lane) => lane.id)).size).toBe(101);
  });

  it("shows the caller's lanes only", async () => {
    const b = make();
    archive(b, 2, "u2");
    expect(await b.service.listArchived(b.browser(), {})).toEqual({ lanes: [], hasMore: false });
  });
});

describe("get", () => {
  it("answers not_found for another owner's lane", async () => {
    const b = make();
    const id = await b.create();
    expect(() => b.service.get({ ...b.browser(), userId: "u2" }, id)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});
