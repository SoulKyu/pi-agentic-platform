import { join } from "node:path";
import type { PlatformContext } from "../platform/index.ts";
import { PlatformRefusal } from "../platform/index.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { within } from "../../kernel/fs/boundary.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createDispatchBed } from "../platform/testing/dispatch-bed.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { createLaneNote } from "./note.ts";
import { createLaneStream } from "./stream.ts";
import { createLanesStore, type LanesStore } from "./store.ts";
import { insertLane } from "./testing/lane-rows.ts";
import { tempHome } from "./testing/script-fakes.ts";

let db: Db;
let store: LanesStore;
let home: ReturnType<typeof tempHome>;
const clock = createFakeClock();
const published: string[] = [];
/** The sessions that live in each lane's folder, by owner. */
const inFolder = new Map<string, string[]>();

beforeEach(() => {
  home = tempHome();
  published.length = 0;
  inFolder.clear();
  db = migrate({
    dbPath: join(home.dir, "state.db"),
    backupsDir: join(home.dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock,
    logger: captureLogger().logger,
  }).db;
  store = createLanesStore(db);
});
afterEach(() => {
  db.close();
  home.dispose();
});

const handlerOf = () =>
  createLaneNote({
    store,
    sessions: { sessionIdsIn: (ownerId, folder) => inFolder.get(`${ownerId}:${folder}`) ?? [] },
    clock,
    publish: (laneId) => void published.push(laneId),
  });

const ctx = (over: Partial<PlatformContext> = {}): PlatformContext => ({
  ownerId: "u1",
  sessionId: "s1",
  type: "lane",
  tainted: false,
  agentId: null,
  signal: new AbortController().signal,
  ...over,
});

function laneWithSession(ownerId = "u1", sessionId = "s1") {
  const lane = insertLane(db, { ownerId });
  inFolder.set(`${ownerId}:${lane.worktree}`, [sessionId]);
  return lane;
}
const noteOf = (id: string) => store.get(id)?.note;

describe("lane.note", () => {
  it("stores the note on the session's lane with its time and publishes the lane", async () => {
    const lane = laneWithSession();
    await handlerOf()({ note: "  fixing the parser  " }, ctx());
    expect(noteOf(lane.id)).toBe("fixing the parser");
    expect(store.get(lane.id)?.noteAt).toBe(clock.now());
    expect(published).toEqual([lane.id]);
  });

  it("stores a note without bidi, zero-width and separator characters, keeping tab and new line", async () => {
    const lane = laneWithSession();
    const dirty = "a\u202Eb\u200Bc\u2028d\u2029e\u0007f\u0085g\tg\nh\uD800i";
    await handlerOf()({ note: dirty }, ctx());
    expect(noteOf(lane.id)).toBe("abcdefg\tg\nh�i");
  });

  it("clips a note of 2 001 characters to 2 000", async () => {
    const lane = laneWithSession();
    await handlerOf()({ note: "x".repeat(2001) }, ctx());
    expect(noteOf(lane.id)).toBe("x".repeat(2000));
  });

  it("clears the note when what is left is empty", async () => {
    const lane = laneWithSession();
    const handler = handlerOf();
    await handler({ note: "wip" }, ctx());
    await handler({ note: " \u200B " }, ctx());
    expect(noteOf(lane.id)).toBeNull();
    expect(store.get(lane.id)?.noteAt).toBeNull();
  });

  it("answers not_found for a session that is in no open lane of its owner", async () => {
    const other = laneWithSession("u2", "s2");
    await expect(handlerOf()({ note: "mine" }, ctx())).rejects.toEqual(new PlatformRefusal("not_found"));
    // The session of another owner is judged by its own owner's lanes: u1 asking about u2's folder finds nothing.
    await expect(handlerOf()({ note: "mine" }, ctx({ sessionId: "s2" }))).rejects.toEqual(
      new PlatformRefusal("not_found"),
    );
    expect(noteOf(other.id)).toBeNull();
    expect(published).toEqual([]);
  });

  it("answers not_found for another owner's lane even when the sessions module would name the session", async () => {
    const lane = laneWithSession("u1", "s1");
    const handler = createLaneNote({
      store,
      sessions: { sessionIdsIn: () => ["s1"] },
      clock,
      publish: (laneId) => void published.push(laneId),
    });
    await expect(handler({ note: "not mine" }, ctx({ ownerId: "u2" }))).rejects.toEqual(
      new PlatformRefusal("not_found"),
    );
    expect(noteOf(lane.id)).toBeNull();
  });

  it("answers not_found for an archived lane", async () => {
    const lane = laneWithSession();
    store.setState(lane.id, "archived", { at: 5 });
    await expect(handlerOf()({ note: "late" }, ctx())).rejects.toEqual(new PlatformRefusal("not_found"));
  });

  it("allows 60 notes an hour per lane and refuses the 61st, then again an hour later", async () => {
    const lane = laneWithSession();
    const other = insertLane(db);
    inFolder.set(`u1:${other.worktree}`, ["s9"]);
    const handler = handlerOf();
    for (let i = 0; i < 60; i++) await handler({ note: `n${i}` }, ctx());
    await expect(handler({ note: "n60" }, ctx())).rejects.toEqual(new PlatformRefusal("rate_limited"));
    expect(noteOf(lane.id)).toBe("n59");
    await expect(handler({ note: "other lane" }, ctx({ sessionId: "s9" }))).resolves.toEqual({});
    await clock.advance(3_600_000);
    await expect(handler({ note: "later" }, ctx())).resolves.toEqual({});
    expect(noteOf(lane.id)).toBe("later");
  });

  it("keeps two lanes whose paths share a prefix apart: a session in /w/ab never writes /w/a's note", async () => {
    const short = insertLane(db, { worktree: "/w/a" });
    const long = insertLane(db, { worktree: "/w/ab" });
    // The sessions module's rule: a session belongs to the folder it works in or under.
    const cwds = new Map([
      ["s-long", "/w/ab"],
      ["s-deep", "/w/ab/src"],
      ["s-short", "/w/a"],
    ]);
    const handler = createLaneNote({
      store,
      sessions: {
        sessionIdsIn: (_owner, folder) =>
          [...cwds].filter(([, cwd]) => within(folder, cwd)).map(([id]) => id),
      },
      clock,
      publish: (laneId) => void published.push(laneId),
    });
    await handler({ note: "in the long one" }, ctx({ sessionId: "s-long" }));
    expect([noteOf(short.id), noteOf(long.id)]).toEqual([null, "in the long one"]);
    await handler({ note: "from a subfolder" }, ctx({ sessionId: "s-deep" }));
    expect([noteOf(short.id), noteOf(long.id)]).toEqual([null, "from a subfolder"]);
    await handler({ note: "in the short one" }, ctx({ sessionId: "s-short" }));
    expect([noteOf(short.id), noteOf(long.id)]).toEqual(["in the short one", "from a subfolder"]);
  });

  it("forgets the windows of lanes that have been quiet for an hour", async () => {
    const first = laneWithSession("u1", "s1");
    const second = laneWithSession("u1", "s2");
    const windows = new Map<string, { startedAt: number; used: number }>();
    const handler = createLaneNote({
      store,
      sessions: { sessionIdsIn: (ownerId, folder) => inFolder.get(`${ownerId}:${folder}`) ?? [] },
      clock,
      publish: (laneId) => void published.push(laneId),
      windows,
    });
    await handler({ note: "one" }, ctx({ sessionId: "s1" }));
    await clock.advance(1_800_000);
    await handler({ note: "two" }, ctx({ sessionId: "s2" }));
    expect([...windows.keys()]).toEqual([first.id, second.id]);
    await clock.advance(1_800_000);
    await handler({ note: "two again" }, ctx({ sessionId: "s2" }));
    expect([...windows.keys()]).toEqual([second.id]);
    expect(windows.get(second.id)?.used).toBe(2);
  });

  it("goes out on the lane stream: the event carries the note", async () => {
    const lane = laneWithSession();
    const events: unknown[] = [];
    const stream = createLaneStream({
      store,
      notices: { list: () => [] },
      logger: captureLogger().logger,
      schedule: (flush) => flush(),
    });
    stream.bind({ publish: (_s, _k, event) => void events.push(event), registerSnapshot: () => undefined });
    const handler = createLaneNote({
      store,
      sessions: { sessionIdsIn: () => ["s1"] },
      clock,
      publish: stream.changed,
    });
    await handler({ note: "<b>bold</b> idea" }, ctx());
    expect(events).toEqual([
      expect.objectContaining({
        kind: "lane",
        lane: expect.objectContaining({ id: lane.id, note: "<b>bold</b> idea" }),
      }),
    ]);
  });

  it("is reached through the dispatcher: a bidi note is stored stripped, not refused", async () => {
    const lane = laneWithSession();
    const bed = createDispatchBed();
    bed.port.register("lane.note", handlerOf());
    bed.session("s1", { type: "lane", agentId: null });
    bed.call("s1", { id: "p1", op: "lane.note", args: { note: "ok\u202E evil" } });
    await bed.settle();
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: true, result: {} }]);
    expect(noteOf(lane.id)).toBe("ok evil");
  });

  describe("the wire cap through the real dispatcher and schema (W5-R20)", () => {
    async function send(note: string) {
      const lane = laneWithSession();
      const bed = createDispatchBed();
      bed.port.register("lane.note", handlerOf());
      bed.session("s1", { type: "lane", agentId: null });
      bed.call("s1", { id: "p1", op: "lane.note", args: { note } });
      await bed.settle();
      return { lane, reply: bed.replies[0] };
    }

    it("stores a 2 001 character note clipped to 2 000", async () => {
      const { lane, reply } = await send("x".repeat(2001));
      expect(reply).toEqual({ type: "platform_result", id: "p1", ok: true, result: {} });
      expect(noteOf(lane.id)).toBe("x".repeat(2000));
    });

    it("refuses 8 001 characters as bad_request and stores nothing", async () => {
      const { lane, reply } = await send("x".repeat(8001));
      expect(reply).toEqual({ type: "platform_result", id: "p1", ok: false, error: "bad_request" });
      expect(noteOf(lane.id)).toBeNull();
    });

    it("never keeps half of a surrogate pair at the clip", async () => {
      const { lane } = await send("x".repeat(1999) + "\u{1F600}");
      expect(noteOf(lane.id)).toBe("x".repeat(1999));
    });
  });
});
