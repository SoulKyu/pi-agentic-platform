import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaneStreamEvent } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { createLaneNotices } from "./notices.ts";
import { createLaneStream } from "./stream.ts";
import { createLanesStore, type LanesStore, type NewLane } from "./store.ts";

let dir: string;
let db: Db;
let store: LanesStore;
const logs = captureLogger();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-lane-stream-"));
  logs.lines.length = 0;
  db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock: createFakeClock(),
    logger: logs.logger,
  }).db;
  store = createLanesStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const lane = (id: string, over: Partial<NewLane> = {}): NewLane => ({
  id,
  ownerId: "u1",
  createdBy: "session",
  projectRoot: "/srv/project",
  worktree: `/srv/pap/worktrees/${id}`,
  branch: `pi/${id}`,
  baseRef: "refs/heads/main",
  baseOid: "a".repeat(40),
  title: `Lane ${id}`,
  description: "",
  source: null,
  model: null,
  ...over,
});

const fanoutId = (n: number): string => n.toString(16).padStart(16, "0");

const harness = () => {
  const clock = createFakeClock();
  const published: Array<{ stream: string; key: string; event: unknown }> = [];
  const snapshots = new Map<string, (key: string) => unknown>();
  const flushes: Array<() => void> = [];
  const notices = createLaneNotices(clock, (id) => stream.changed(id));
  const stream = createLaneStream({
    store,
    notices,
    logger: logs.logger,
    schedule: (flush) => void flushes.push(flush),
  });
  stream.bind({
    publish: (name, key, event) => void published.push({ stream: name, key, event }),
    registerSnapshot: (name, provider) => void snapshots.set(name, provider),
  });
  return { stream, notices, published, snapshots, flush: () => flushes.splice(0).forEach((run) => run()) };
};

describe("the lane stream", () => {
  it("shows the pull request, forge and remote that Task 14 supplies, and nothing without them", () => {
    const pr = {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      state: "open" as const,
      draft: false,
      conflicts: null,
      checks: null,
      checkedAt: null,
      error: null,
    };
    store.insert(lane("a-0001"), 1);
    const plain = createLaneStream({
      store,
      notices: createLaneNotices(createFakeClock(), () => undefined),
      logger: logs.logger,
    });
    expect(plain.view("a-0001")).toMatchObject({ pr: null, forge: null, remote: null, pushRemote: null });
    const withOutward = createLaneStream({
      store,
      notices: createLaneNotices(createFakeClock(), () => undefined),
      logger: logs.logger,
      outward: () => ({
        pr,
        forge: "github",
        remote: { host: "github.com", path: "o/r" },
        pushRemote: { host: "github.com", path: "o/r" },
      }),
    });
    const view = withOutward.view("a-0001");
    expect(view).toMatchObject({ pr, forge: "github", remote: { host: "github.com", path: "o/r" } });
    expect(LaneStreamEvent.safeParse({ kind: "lane", lane: view }).success).toBe(true);
  });

  it("registers a snapshot of the caller's non-archived lanes, the fan-outs they name and the archived count", () => {
    const { snapshots } = harness();
    store.insert(lane("a-0001"), 1);
    store.insert(lane("b-0001", { ownerId: "u2" }), 1);
    db.run(
      "INSERT INTO lane_fanouts (id, owner_id, prompt, created_at) VALUES ('1111111111111111', 'u1', 'go', 3)",
    );
    db.run("UPDATE lanes SET fanout_id = '1111111111111111', fanout_slot = 0 WHERE id = 'a-0001'");
    store.insert(lane("c-0001"), 1);
    store.setState("c-0001", "archived", { at: 5 });
    const event = snapshots.get("lane")?.("u1") as LaneStreamEvent;
    expect(LaneStreamEvent.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({ kind: "snapshot", archived: 1 });
    if (event.kind !== "snapshot") throw new Error("not a snapshot");
    expect(event.lanes.map((view) => view.id)).toEqual(["a-0001"]);
    expect(event.fanouts).toEqual([
      { id: "1111111111111111", prompt: "go", createdAt: 3, laneIds: ["a-0001"] },
    ]);
  });

  it("fits the snapshot under PAGE_BYTES: 64 lanes with 4 KiB paths and big prompts keep the newest", () => {
    const { stream } = harness();
    const path = (tag: string) => `/${tag}${"p".repeat(3990)}`;
    for (let n = 0; n < 64; n++) {
      const id = `lane${String(n).padStart(2, "0")}-0001`;
      db.run("INSERT INTO lane_fanouts (id, owner_id, prompt, created_at) VALUES ($id, 'u1', $prompt, 1)", {
        id: fanoutId(n),
        prompt: "x".repeat(24_000),
      });
      store.insert(lane(id, { projectRoot: path("r"), worktree: path(`w${n}`) }), n);
      db.run("UPDATE lanes SET fanout_id = $f, fanout_slot = 0 WHERE id = $id", { f: fanoutId(n), id });
    }
    const event = stream.snapshot("u1");
    if (event.kind !== "snapshot") throw new Error("not a snapshot");
    expect(sizeOf(event)).toBeLessThanOrEqual(PAGE_BYTES);
    expect(event.lanes.length).toBeGreaterThan(0);
    expect(event.lanes.length).toBeLessThan(64);
    expect(event.lanes[0]?.id).toBe("lane63-0001");
    // The oldest lanes were left out, and the event says so (a snapshot that looks whole is a lie).
    expect(event.truncated).toBe(true);
    expect(event.fanouts.map((fanout) => fanout.id)).toEqual(
      event.lanes.map((view) => fanoutId(Number(view.id.slice(4, 6)))),
    );
    expect(LaneStreamEvent.safeParse(event).success).toBe(true);
  });

  it("keeps all 64 lanes when they fit", () => {
    const { stream } = harness();
    for (let n = 0; n < 64; n++) store.insert(lane(`lane${String(n).padStart(2, "0")}-0001`), n);
    const event = stream.snapshot("u1");
    if (event.kind !== "snapshot") throw new Error("not a snapshot");
    expect(event.lanes).toHaveLength(64);
    expect(event.truncated).toBe(false);
  });

  it("publishes a fan-out event to its owner at once, and nothing for another owner's or a missing group", () => {
    const { stream, published } = harness();
    db.run(
      "INSERT INTO lane_fanouts (id, owner_id, prompt, created_at) VALUES ('1111111111111111', 'u1', 'go', 3)",
    );
    stream.fanoutChanged("u2", "1111111111111111");
    stream.fanoutChanged("u1", "2222222222222222");
    expect(published).toEqual([]);
    stream.fanoutChanged("u1", "1111111111111111");
    expect(published).toEqual([
      {
        stream: "lane",
        key: "u1",
        event: {
          kind: "fanout",
          fanout: { id: "1111111111111111", prompt: "go", createdAt: 3, laneIds: [] },
        },
      },
    ]);
  });

  it("publishes one lane event for three changes of a lane in one tick, to the lane's owner", () => {
    const { stream, published, flush } = harness();
    store.insert(lane("a-0001"), 1);
    store.insert(lane("b-0001", { ownerId: "u2" }), 1);
    stream.changed("a-0001");
    store.setState("a-0001", "active");
    stream.changed("a-0001");
    stream.changed("a-0001");
    stream.changed("b-0001");
    expect(published).toEqual([]);
    flush();
    expect(
      published.map((entry) => [entry.stream, entry.key, (entry.event as { lane: { id: string } }).lane.id]),
    ).toEqual([
      ["lane", "u1", "a-0001"],
      ["lane", "u2", "b-0001"],
    ]);
    expect(published[0]?.event).toMatchObject({ kind: "lane", lane: { id: "a-0001", state: "active" } });
    stream.changed("a-0001");
    flush();
    expect(published).toHaveLength(3);
  });

  it("publishes a lane's notices with it", () => {
    const { notices, published, flush } = harness();
    store.insert(lane("a-0001"), 1);
    notices.add("a-0001", "copy_skipped", 2);
    flush();
    expect(published[0]?.event).toMatchObject({
      lane: { notices: [{ kind: "copy_skipped", count: 2 }] },
    });
  });

  it("skips a lane that is gone and goes on with the others", () => {
    const { stream, published, flush } = harness();
    store.insert(lane("a-0001"), 1);
    stream.changed("ghost-0001");
    stream.changed("a-0001");
    flush();
    expect(published).toHaveLength(1);
  });

  it("logs a publish that throws and still publishes the next lane", () => {
    const flushes: Array<() => void> = [];
    const stream = createLaneStream({
      store,
      notices: createLaneNotices(createFakeClock(), () => undefined),
      logger: logs.logger,
      schedule: (flush) => void flushes.push(flush),
    });
    const seen: string[] = [];
    stream.bind({
      registerSnapshot: () => undefined,
      publish: (_name, _key, event) => {
        const id = (event as { lane: { id: string } }).lane.id;
        if (id === "a-0001") throw new Error("boom");
        seen.push(id);
      },
    });
    store.insert(lane("a-0001"), 1);
    store.insert(lane("b-0001"), 1);
    stream.changed("a-0001");
    stream.changed("b-0001");
    flushes.splice(0).forEach((run) => run());
    expect(seen).toEqual(["b-0001"]);
    expect(logs.lines.some((line) => line.msg === "lane_publish_failed")).toBe(true);
  });

  it("publishes nothing before a hub is bound, and does not fail", () => {
    const flushes: Array<() => void> = [];
    const stream = createLaneStream({
      store,
      notices: createLaneNotices(createFakeClock(), () => undefined),
      logger: logs.logger,
      schedule: (flush) => void flushes.push(flush),
    });
    store.insert(lane("a-0001"), 1);
    stream.changed("a-0001");
    expect(() => flushes.splice(0).forEach((run) => run())).not.toThrow();
  });
});
