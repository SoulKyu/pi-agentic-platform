import { type EventFrame, type MarkChange, NO_MARKS, type ShellStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createSessionsService } from "./service.ts";
import { createSessionMarks } from "./service-marks.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const OWNER = testCaller();
const T = 1_800_000_000_000;

/** Sessions `a`, `b`, `c` of the owner, created in that order, at time T. */
async function threeSessions() {
  bed = build();
  await bed.clock.advance(T - bed.clock.now());
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await bed.service.create(bed.work, OWNER)).sessionId);
  const [a = "", b = "", c = ""] = ids;
  return { a, b, c };
}

function watchShell() {
  bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
  const frames: EventFrame[] = [];
  bed.hub.open({
    connectionId: "c-shell",
    sub: "s-shell",
    stream: "shell",
    key: "u1",
    after: undefined,
    send: (frame) => void frames.push(frame),
  });
  frames.length = 0;
  return () => frames.splice(0).map((frame) => frame.event as ShellStreamEvent);
}
const drain = () => bed.clock.advance(0);
const sessionEvents = (events: ShellStreamEvent[]) =>
  events.flatMap((event) => (event.kind === "session" ? [event.session] : []));
const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe("sessions.mark", () => {
  it("pins a before b: the pins read b then a, and the events carry both ranks", async () => {
    const { a, b } = await threeSessions();
    bed.service.mark({ sessionId: a, change: { kind: "pin", before: null } }, OWNER);
    await drain();
    const events = watchShell();
    bed.service.mark({ sessionId: b, change: { kind: "pin", before: a } }, OWNER);
    await drain();
    expect(bed.store.marks.pins("u1")).toEqual([b, a]);
    const ranks = Object.fromEntries(sessionEvents(events()).map((s) => [s.id, s.pinRank]));
    expect(ranks).toEqual({ [b]: 1, [a]: 2 });
  });

  it("refuses a 51st pin with limit_reached and writes nothing", async () => {
    const { a } = await threeSessions();
    const projectId = bed.store.marks.row(a)?.projectId ?? null;
    const seeded: string[] = [];
    bed.db.transaction(() => {
      for (let i = 0; i < 50; i++) {
        const id = `seed${i}`;
        bed.store.insert(
          {
            id,
            piPath: null,
            piSessionId: null,
            cwd: "/w",
            ownerId: "u1",
            name: null,
            createdAt: 1,
            updatedAt: 1,
          },
          projectId,
        );
        seeded.push(id);
      }
      for (const id of seeded) bed.store.marks.write(id, NO_MARKS, null);
      bed.store.marks.write("seed0", NO_MARKS, { ownerId: "u1", order: seeded });
    });
    expect(
      codeOf(() => bed.service.mark({ sessionId: a, change: { kind: "pin", before: null } }, OWNER)),
    ).toBe("limit_reached");
    expect(bed.store.marks.pins("u1")).toEqual(seeded);
    expect(bed.store.marks.row(a)?.marks.pinRank).toBeNull();
  });

  it("archives a pinned session: archivedAt set, no rank, and session, counts and project events", async () => {
    const { a, b } = await threeSessions();
    bed.service.mark({ sessionId: a, change: { kind: "pin", before: null } }, OWNER);
    await drain();
    const events = watchShell();
    bed.service.mark({ sessionId: a, change: { kind: "archive" } }, OWNER);
    await drain();
    expect(bed.store.marks.row(a)?.marks).toMatchObject({ archivedAt: T, pinRank: null });
    expect(events()).toEqual([
      expect.objectContaining({
        kind: "session",
        session: expect.objectContaining({ id: a, archivedAt: T }),
      }),
      expect.objectContaining({ kind: "project", project: expect.objectContaining({ sessions: 2 }) }),
      { kind: "counts", archived: 1 },
    ]);
    expect(b).not.toBe(a);
  });

  it("writes a snooze in range, refuses one out of range, and tells the organiser once", async () => {
    const { c } = await threeSessions();
    const spy = vi.fn();
    const marks = createSessionMarks({
      store: bed.store.marks,
      clock: bed.clock,
      owned: (id) => {
        const row = bed.store.get(id);
        if (!row) throw new Error("no session");
        return row;
      },
      publisher: { changed: vi.fn(), projectChanged: vi.fn(), countsChanged: vi.fn() },
      onSnoozeChange: spy,
    });
    const mark = (change: MarkChange) => marks.mark({ sessionId: c, change }, OWNER);
    mark({ kind: "snooze", until: T + 30 * 60_000 });
    expect(bed.store.marks.row(c)?.marks.snoozedUntil).toBe(T + 30 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(codeOf(() => mark({ kind: "snooze", until: T + 1000 }))).toBe("bad_request");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("puts an archived pin back at rank 2 among b, a with restore (Undo)", async () => {
    const { a, b } = await threeSessions();
    bed.service.mark({ sessionId: a, change: { kind: "pin", before: null } }, OWNER);
    bed.service.mark({ sessionId: b, change: { kind: "pin", before: a } }, OWNER);
    const state = { pinned: true, pinBefore: null, archived: false, settled: false, snoozedUntil: null };
    bed.service.mark({ sessionId: a, change: { kind: "archive" } }, OWNER);
    expect(bed.store.marks.pins("u1")).toEqual([b]);
    bed.service.mark({ sessionId: a, change: { kind: "restore", state } }, OWNER);
    expect(bed.store.marks.pins("u1")).toEqual([b, a]);
    expect(bed.store.marks.row(a)?.marks).toMatchObject({ pinRank: 2, archivedAt: null });
  });

  it("answers not_found for another owner's session and changes nothing", async () => {
    const { a } = await threeSessions();
    const other = testCaller({ userId: "u2" });
    expect(codeOf(() => bed.service.mark({ sessionId: a, change: { kind: "archive" } }, other))).toBe(
      "not_found",
    );
    expect(bed.store.marks.row(a)?.marks.archivedAt).toBeNull();
  });

  it("leaves the worker of an archived running session running", async () => {
    const { a } = await threeSessions();
    bed.emit(0, { type: "agent_start" });
    await drain();
    expect(bed.service.list(OWNER).find((s) => s.id === a)?.status).toBe("running");
    bed.service.mark({ sessionId: a, change: { kind: "archive" } }, OWNER);
    await drain();
    expect(bed.spawned[0]?.stopped()).toBe(false);
    expect(bed.service.list(OWNER).find((s) => s.id === a)?.status).toBe("running");
  });

  it("maps a refused write in a read-only database to read_only", async () => {
    const { a } = await threeSessions();
    vi.spyOn(bed.store.marks, "write").mockImplementation(() => {
      throw new Error("attempt to write a readonly database");
    });
    expect(codeOf(() => bed.service.mark({ sessionId: a, change: { kind: "archive" } }, OWNER))).toBe(
      "read_only",
    );
  });
});
