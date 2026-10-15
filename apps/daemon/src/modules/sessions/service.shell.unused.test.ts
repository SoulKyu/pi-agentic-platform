import { type EventFrame, type Marks, SHELL_LIMITS, type ShellStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const NO_MARKS: Marks = {
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  settledAuto: false,
  unsettledAt: null,
  snoozedUntil: null,
};
const insert = (id: string, cwd: string, ownerId = "u1", marks: Partial<Marks> = {}) => {
  bed.store.insert(
    { id, piPath: null, piSessionId: null, cwd, ownerId, name: null, createdAt: 1, updatedAt: 1 },
    `p:${cwd}`,
  );
  if (Object.keys(marks).length > 0) bed.store.marks.write(id, { ...NO_MARKS, ...marks }, null);
};
const projectsOf = (ownerId: string) => {
  const snapshot = bed.service.shellSnapshot(ownerId);
  if (snapshot.kind !== "snapshot") throw new Error("not a snapshot");
  return snapshot.projects;
};

describe("projects no session files under yet (decision 85, PH3)", () => {
  it("are in the snapshot, flagged unused, beside the active ones; all-archived and other owners' are not", () => {
    bed = build();
    insert("a", "/w/a");
    insert("old", "/w/old", "u1", { archivedAt: 5 });
    for (const root of ["/w/a", "/w/old", "/w/new"]) bed.projects.ensure("u1", root);
    bed.projects.ensure("u2", "/w/theirs");
    expect(projectsOf("u1")).toEqual([
      { id: "p:/w/a", root: "/w/a", name: "a", position: 0, sessions: 1 },
      { id: "p:/w/new", root: "/w/new", name: "new", position: 0, sessions: 0, unused: true },
    ]);
    expect(projectsOf("u2").map((project) => project.id)).toEqual(["p:/w/theirs"]);
  });

  it("never displace an active project when the snapshot is full", () => {
    bed = build();
    const others = SHELL_LIMITS.projects - 1;
    // The unused ones sort first (equal positions, then id). One busy project fills the session window, so the
    // others are listed only through the project cap, which must keep every active one.
    for (let index = 0; index < 5; index += 1) bed.projects.ensure("u1", `/w/0-unused-${index}`);
    for (let index = 0; index < others; index += 1) {
      insert(`s${index}`, `/w/1-active-${index}`);
      bed.projects.ensure("u1", `/w/1-active-${index}`);
    }
    for (let index = 0; index < SHELL_LIMITS.sessions + SHELL_LIMITS.pins + 10; index += 1) {
      bed.store.insert(
        {
          id: `big${index}`,
          piPath: null,
          piSessionId: null,
          cwd: "/w/2-big",
          ownerId: "u1",
          name: null,
          createdAt: 9,
          updatedAt: 9,
        },
        "p:/w/2-big",
      );
    }
    bed.projects.ensure("u1", "/w/2-big");
    const snapshot = bed.service.shellSnapshot("u1");
    if (snapshot.kind !== "snapshot") throw new Error("not a snapshot");
    const ids = new Set(snapshot.projects.map((project) => project.id));
    for (let index = 0; index < others; index += 1) expect(ids.has(`p:/w/1-active-${index}`)).toBe(true);
    expect(ids.has("p:/w/2-big")).toBe(true);
    expect(snapshot.projects).toHaveLength(SHELL_LIMITS.projects);
  });

  it("drop the flag once a session files under the project", () => {
    bed = build();
    bed.projects.ensure("u1", "/w/new");
    expect(projectsOf("u1")).toEqual([
      { id: "p:/w/new", root: "/w/new", name: "new", position: 0, sessions: 0, unused: true },
    ]);
    insert("s", "/w/new");
    expect(projectsOf("u1")).toEqual([
      { id: "p:/w/new", root: "/w/new", name: "new", position: 0, sessions: 1 },
    ]);
  });

  it("go out as a project event flagged unused when the project is made", async () => {
    bed = build();
    bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
    const frames: EventFrame[] = [];
    bed.hub.open({
      connectionId: "c",
      sub: "s",
      stream: "shell",
      key: "u1",
      after: undefined,
      send: (frame) => void frames.push(frame),
    });
    frames.length = 0;
    bed.projects.ensure("u1", "/w/new");
    await bed.clock.advance(0);
    expect(frames.map((frame) => frame.event as ShellStreamEvent)).toContainEqual({
      kind: "project",
      project: { id: "p:/w/new", root: "/w/new", name: "new", position: 0, sessions: 0, unused: true },
    });
  });
});
