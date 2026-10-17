import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { MemoryStatus } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_STALE_MS, readHealth, readItems, readJournal, readProjects } from "./snapshots.ts";
import { AGENT, createMem0Layout, type Mem0Layout } from "./testing/layout.ts";

let layout: Mem0Layout;
afterEach(() => layout.dispose());
const setup = (): Mem0Layout => (layout = createMem0Layout());
const USER = { kind: "user" } as const;
const item = (id: string, createdAt: string | null = "2026-10-16T08:00:00Z", text = `text ${id}`) => ({
  id,
  text,
  source: "agent",
  ...(createdAt === null ? {} : { createdAt }),
});

describe("snapshots (M11R146)", () => {
  it("reads the user snapshot, newest first", () => {
    setup();
    layout.json("scopes/user.json", {
      memories: [
        item("a", "2026-10-16T08:00:00Z"),
        item("c", "2026-10-16T10:00:00Z"),
        item("b", "2026-10-16T09:00:00Z"),
      ],
    });
    expect(readItems(layout.mem0, USER).map((each) => each.id)).toEqual(["c", "b", "a"]);
  });

  it("is empty when the snapshot is missing, a link, not JSON or over 1 MiB", () => {
    setup();
    expect(readItems(layout.mem0, USER)).toEqual([]);
    const real = layout.json("elsewhere.json", { memories: [item("a")] });
    layout.dir("scopes");
    symlinkSync(real, join(layout.mem0, "scopes", "user.json"));
    expect(readItems(layout.mem0, USER)).toEqual([]);
    layout.dispose();
    setup();
    layout.json("scopes/user.json", "{nope");
    expect(readItems(layout.mem0, USER)).toEqual([]);
    layout.json("scopes/user.json", JSON.stringify({ memories: [item("a", null, "x".repeat(1_048_576))] }));
    expect(readItems(layout.mem0, USER)).toEqual([]);
  });

  it("reads a snapshot of exactly 1 MiB and refuses one byte more", () => {
    setup();
    const head = '{"memories":[{"id":"a","text":"';
    const tail = '"}]}';
    const body = (size: number): string => head + "x".repeat(size - head.length - tail.length) + tail;
    layout.json("scopes/user.json", body(1_048_576));
    expect(readItems(layout.mem0, USER)).toHaveLength(1);
    layout.json("scopes/user.json", body(1_048_577));
    expect(readItems(layout.mem0, USER)).toEqual([]);
  });

  it("skips a malformed item and keeps the others", () => {
    setup();
    layout.json("scopes/user.json", {
      memories: [
        item("ok"),
        { id: "../x", text: "bad id" },
        { id: "no-text" },
        { id: "num", text: 5 },
        null,
        "string",
        { id: "bad-date", text: "t", createdAt: 5 },
        { id: "empty", text: "" },
      ],
    });
    expect(readItems(layout.mem0, USER).map((each) => each.id)).toEqual(["ok"]);
  });

  it("keeps the 200 newest and clips a text to 4096 characters", () => {
    setup();
    const items = Array.from({ length: 205 }, (_, i) =>
      item(
        `m${i}`,
        `2026-10-16T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
        "x".repeat(5000),
      ),
    );
    layout.json("scopes/user.json", { memories: items });
    const read = readItems(layout.mem0, USER);
    expect(read).toHaveLength(200);
    expect(read[0]?.id).toBe("m204");
    expect(read.at(-1)?.id).toBe("m5");
    expect(read[0]?.text).toHaveLength(4096);
  });

  it("reads project and agent snapshots at their paths, and nothing for a bad id", () => {
    setup();
    layout.json("scopes/project-p1.json", { memories: [item("p")] });
    layout.json(`agents/${AGENT}.json`, { memories: [item("g")] });
    expect(readItems(layout.mem0, { kind: "project", id: "p1" }).map((each) => each.id)).toEqual(["p"]);
    expect(readItems(layout.mem0, { kind: "agent", id: AGENT }).map((each) => each.id)).toEqual(["g"]);
    expect(readItems(layout.mem0, { kind: "project", id: "../x" })).toEqual([]);
  });

  it("reads the agent journal (`events`), the 100 newest, field-checked, adds apart from forgets", () => {
    setup();
    const at = (i: number): string =>
      `2026-10-16T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    const events = Array.from({ length: 105 }, (_, i) => ({
      at: at(i),
      kind: i === 104 ? "forget" : "add",
      id: `m${i}`,
      text: `entry ${i}`,
      source: i === 104 ? "pi-web" : "agent",
      scope: "agent",
    }));
    layout.json(`agents/${AGENT}.json`, {
      agent: AGENT,
      updatedAt: at(0),
      memories: [],
      events: [
        ...events,
        { at: at(110), kind: "other", id: "x", text: "t", source: "s", scope: "u" },
        { text: 5 },
        7,
      ],
    });
    const read = readJournal(layout.mem0, AGENT);
    expect(read).toHaveLength(100);
    expect(read[0]).toEqual({ at: at(104), kind: "forget", text: "entry 104", source: "pi-web" });
    expect(read[1]?.kind).toBe("add");
    expect(readJournal(layout.mem0, "../x")).toEqual([]);
  });

  it("ignores the old `items` and `journal` keys: only pi-mem0's own are read", () => {
    setup();
    layout.json("scopes/user.json", { items: [item("a")] });
    layout.json(`agents/${AGENT}.json`, { journal: [{ at: "2026-10-16T08:00:00Z", text: "t" }] });
    expect(readItems(layout.mem0, USER)).toEqual([]);
    expect(readJournal(layout.mem0, AGENT)).toEqual([]);
  });

  it("reads scopes/index.json: the key is the id, `label` the name, `cwd` never surfaces", () => {
    setup();
    layout.json("scopes/index.json", {
      projects: {
        p1: { label: "Pap", cwd: "/home/secret/pap" },
        "../x": { label: "bad", cwd: "/x" },
        p2: { cwd: "/y" },
        p3: 3,
      },
    });
    const read = readProjects(layout.mem0);
    expect(read).toEqual([
      { id: "p1", name: "Pap" },
      { id: "p2", name: "p2" },
    ]);
    expect(JSON.stringify(read)).not.toContain("secret");
    layout.json("projects.json", { projects: [{ id: "old", name: "Old" }] });
    expect(readProjects(layout.mem0).map((each) => each.id)).toEqual(["p1", "p2"]);
  });

  it("keeps an empty createdAt and a source, and skips a non-string createdAt", () => {
    setup();
    layout.json("scopes/user.json", {
      memories: [
        { id: "a", text: "t", createdAt: "", source: "pi-web" },
        { id: "b", text: "t", createdAt: 5, source: "x" },
      ],
    });
    expect(readItems(layout.mem0, USER)).toEqual([{ id: "a", text: "t", createdAt: "", source: "pi-web" }]);
  });

  it("clips lastCaptureError by UTF-16 units as the contract does, never in the middle of a pair", () => {
    setup();
    const now = 1_700_000_000_000;
    const write = (error: string) =>
      layout.json("health.json", { watcherAt: new Date(now).toISOString(), lastCaptureError: error });
    write("\u{1F600}".repeat(400));
    const clipped = readHealth(layout.mem0, now).lastCaptureError;
    expect(clipped).toBe("\u{1F600}".repeat(150));
    expect(MemoryStatus.shape.lastCaptureError.safeParse(clipped).success).toBe(true);
    // An odd cut: one unit, then pairs: the 300th unit would be half a pair.
    write(`a${"\u{1F600}".repeat(200)}`);
    expect(readHealth(layout.mem0, now).lastCaptureError).toBe(`a${"\u{1F600}".repeat(149)}`);
  });

  it("tells a fresh watcher from a stale or silent one", () => {
    setup();
    const now = 1_700_000_000_000;
    expect(readHealth(layout.mem0, now)).toEqual({
      state: "unknown",
      checkedAt: null,
      lastCaptureError: null,
      lastCaptureAt: null,
    });
    layout.json("health.json", { watcherAt: new Date(now - HEALTH_STALE_MS).toISOString() });
    expect(readHealth(layout.mem0, now)).toEqual({
      state: "fresh",
      checkedAt: now - HEALTH_STALE_MS,
      lastCaptureError: null,
      lastCaptureAt: null,
    });
    layout.json("health.json", { watcherAt: new Date(now - HEALTH_STALE_MS - 1).toISOString() });
    expect(readHealth(layout.mem0, now).state).toBe("stale");
    layout.json("health.json", { watcherAt: new Date(now - 1000).toISOString(), pid: 1 });
    expect(readHealth(layout.mem0, now)).toEqual({
      state: "fresh",
      checkedAt: now - 1000,
      lastCaptureError: null,
      lastCaptureAt: null,
    });
    layout.json("health.json", { watcherAt: "yesterday" });
    expect(readHealth(layout.mem0, now)).toEqual({
      state: "unknown",
      checkedAt: null,
      lastCaptureError: null,
      lastCaptureAt: null,
    });
    layout.json("health.json", {
      watcherAt: new Date(now).toISOString(),
      lastCaptureAt: "2026-10-16T07:00:00.000Z",
      lastCaptureError: "x".repeat(400),
    });
    expect(readHealth(layout.mem0, now)).toMatchObject({
      lastCaptureAt: "2026-10-16T07:00:00.000Z",
      lastCaptureError: "x".repeat(300),
    });
    layout.json("health.json", {
      watcherAt: new Date(now).toISOString(),
      lastCaptureError: 5,
      lastCaptureAt: "",
    });
    expect(readHealth(layout.mem0, now)).toMatchObject({ lastCaptureError: null, lastCaptureAt: null });
    layout.json("health.json", { watcherAt: new Date(now).toISOString(), lastCaptureError: "" });
    expect(readHealth(layout.mem0, now).lastCaptureError).toBeNull();
    layout.json("health.json", { updatedAt: new Date(now).toISOString() });
    expect(readHealth(layout.mem0, now)).toEqual({
      state: "unknown",
      checkedAt: null,
      lastCaptureError: null,
      lastCaptureAt: null,
    });
  });
});
