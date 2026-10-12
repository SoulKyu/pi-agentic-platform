import type { EventFrame, Marks, ShellStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const OWNER = testCaller();
const NO_MARKS: Marks = {
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  settledAuto: false,
  unsettledAt: null,
  snoozedUntil: null,
};

const insert = (id: string, updatedAt: number, cwd = "/w/a", ownerId = "u1", marks: Partial<Marks> = {}) => {
  bed.store.insert(
    { id, piPath: null, piSessionId: null, cwd, ownerId, name: null, createdAt: updatedAt, updatedAt },
    `p:${cwd}`,
  );
  if (Object.keys(marks).length > 0) bed.store.marks.write(id, { ...NO_MARKS, ...marks }, null);
};

/** A client of the owner's `shell` stream: what it receives, after the snapshot. */
function watchShell(ownerId = "u1") {
  bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
  const frames: EventFrame[] = [];
  bed.hub.open({
    connectionId: "c-shell",
    sub: "s-shell",
    stream: "shell",
    key: ownerId,
    after: undefined,
    send: (frame) => void frames.push(frame),
  });
  frames.length = 0;
  return () => frames.splice(0).map((frame) => frame.event as ShellStreamEvent);
}
const drain = () => bed.clock.advance(0);

const ask = (id: string) => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run?",
  message: "bash: npm test",
  answers: ["deny", "once"] as Array<"deny" | "once">,
  tool: "bash",
  key: "a".repeat(64),
});

describe("the shell snapshot", () => {
  it("lists a pinned session first, then the newest; archived ones are counted in archived only", () => {
    bed = build();
    insert("a", 100);
    insert("b", 200);
    insert("c", 300, "/w/a", "u1", { pinRank: 1 });
    insert("d", 400, "/w/a", "u1", { archivedAt: 500 });
    const snapshot = bed.service.shellSnapshot("u1");
    if (snapshot.kind !== "snapshot") throw new Error("not a snapshot");
    expect(snapshot.sessions.map((s) => s.id)).toEqual(["c", "b", "a"]);
    expect(snapshot).toMatchObject({ more: 0, archived: 1, moreProjects: 0 });
    expect(snapshot.projects).toEqual([{ id: "p:/w/a", root: "/w/a", name: "a", position: 0, sessions: 3 }]);
  });

  it("carries a project none of whose sessions is in the window (RT-09)", () => {
    bed = build();
    bed.db.transaction(() => {
      for (let i = 1; i <= 3; i++) insert(`old${i}`, i, "/w/old");
      for (let i = 1; i <= 551; i++) insert(`new${i}`, 1000 + i, "/w/new");
    });
    const snapshot = bed.service.shellSnapshot("u1");
    if (snapshot.kind !== "snapshot") throw new Error("not a snapshot");
    expect(snapshot.sessions).toHaveLength(550);
    expect(snapshot.sessions.some((s) => s.id.startsWith("old"))).toBe(false);
    expect(snapshot.projects.map((p) => [p.id, p.sessions]).sort()).toEqual([
      ["p:/w/new", 551],
      ["p:/w/old", 3],
    ]);
    expect(snapshot.moreProjects).toBe(0);
    expect(snapshot.more).toBe(4);
  });

  it("never shows another owner's sessions or projects", () => {
    bed = build();
    insert("mine", 100, "/w/mine");
    insert("theirs", 200, "/w/theirs", "u2");
    const snapshot = bed.service.shellSnapshot("u1");
    if (snapshot.kind !== "snapshot") throw new Error("not a snapshot");
    expect(snapshot.sessions.map((s) => s.id)).toEqual(["mine"]);
    expect(snapshot.projects.map((p) => p.id)).toEqual(["p:/w/mine"]);
    expect(bed.service.summary("theirs", "u1")).toBeNull();
    expect(bed.service.summary("theirs", "u2")?.id).toBe("theirs");
    const other = bed.service.shellSnapshot("u3");
    expect(other).toMatchObject({ sessions: [], projects: [], archived: 0 });
  });
});

describe("the shell stream's events", () => {
  it("publishes a session event and a project event when a session is created", async () => {
    bed = build();
    const events = watchShell();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await drain();
    const got = events();
    // The project is announced when the projects module first makes it (before the row exists), and again with the session.
    expect(new Set(got.map((event) => event.kind))).toEqual(new Set(["session", "project"]));
    expect(got.filter((event) => event.kind === "session")).toEqual([
      expect.objectContaining({ session: expect.objectContaining({ id: sessionId, status: "idle" }) }),
    ]);
    expect(got.at(-1)).toMatchObject({ kind: "project", project: { sessions: 1 } });
  });

  it("does not publish to another owner's channel", async () => {
    bed = build();
    const theirs = watchShell("u2");
    await bed.service.create(bed.work, OWNER);
    await drain();
    expect(theirs()).toEqual([]);
  });

  it("turns needsInput on at an approval request and off at its answer", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const events = watchShell();
    const needs = () =>
      events().map((event) => (event.kind === "session" ? event.session.needsInput : "other"));
    bed.spawned[0]?.emit(ask("a1"));
    await drain();
    expect(needs()).toEqual([true]);
    bed.service.respondDialog({ sessionId, dialogId: "a1", response: { answer: "once" } }, OWNER);
    await drain();
    expect(needs()).toEqual([false]);
  });

  it("publishes the touched summary when a prompt is sent", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const events = watchShell();
    bed.clock.advance(5000);
    await bed.service.prompt({ sessionId, text: "hello" }, OWNER);
    await drain();
    const sessions = events().flatMap((event) => (event.kind === "session" ? [event.session] : []));
    expect(sessions.at(-1)).toMatchObject({ id: sessionId, updatedAt: bed.store.get(sessionId)?.updatedAt });
    expect(sessions.at(-1)?.updatedAt).toBeGreaterThanOrEqual(5000);
  });
});

describe("listArchived", () => {
  it("pages the archived sessions newest archive first, and has nothing for an empty owner", async () => {
    bed = build();
    insert("a", 1, "/w/a", "u1", { archivedAt: 10 });
    insert("b", 2, "/w/a", "u1", { archivedAt: 30 });
    insert("c", 3, "/w/a", "u1", { archivedAt: 20 });
    insert("x", 4, "/w/a", "u2", { archivedAt: 40 });
    const first = bed.service.listArchived(OWNER, { limit: 2 });
    expect(first.sessions.map((s) => s.id)).toEqual(["b", "c"]);
    expect(first.hasMore).toBe(true);
    const second = bed.service.listArchived(OWNER, { before: { archivedAt: 20, id: "c" }, limit: 2 });
    expect(second.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(second.hasMore).toBe(false);
    expect(bed.service.listArchived(testCaller({ userId: "nobody" }), {})).toEqual({
      sessions: [],
      hasMore: false,
    });
  });
});

describe("sessions.list under the page (M4R35)", () => {
  it("answers the owner's sessions, not truncated", () => {
    bed = build();
    insert("a", 1);
    insert("b", 2, "/w/a", "u2");
    expect(bed.service.listFitted(OWNER)).toEqual({
      sessions: [expect.objectContaining({ id: "a" })],
      truncated: false,
    });
  });
});
