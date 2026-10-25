import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxRef, type LaunchesStreamEvent } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AGENT_VM_MIGRATIONS, createLaunchRegistry } from "./index.ts";

const BOX: BoxRef = { kind: "project", id: "11111111-1111-4111-8111-111111111111" };
const OWNER = "owner-1";
let dir: string;
let clock: FakeClock;
let db: Db;
let sent: Array<{ key: string; event: LaunchesStreamEvent }>;
let subscribed: Set<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-launches-"));
  clock = createFakeClock();
  db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, AGENT_VM_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  sent = [];
  subscribed = new Set();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function make() {
  const snapshots = new Map<string, (key: string) => unknown>();
  const registry = createLaunchRegistry({
    clock,
    db,
    logger: silentLogger,
    hub: {
      publish: (_stream, key, event) => void sent.push({ key, event: event as LaunchesStreamEvent }),
      registerSnapshot: (stream, provider) => void snapshots.set(stream, provider),
      hasSubscribers: (_stream, key) => subscribed.has(key),
    },
  });
  return { registry, snapshots };
}

/** One run of a step: `ms` long, recorded when it ends. */
async function run(
  registry: ReturnType<typeof make>["registry"],
  step: "vm" | "image",
  ms: number,
  end = "done",
) {
  const handle = registry.open({ box: BOX, owner: OWNER, for: "start" });
  handle.step(step, "running");
  await clock.advance(ms);
  handle.step(step, end as "done");
  handle.end(true);
}
function usualOf(registry: ReturnType<typeof make>["registry"], step: "vm" | "image") {
  const handle = registry.open({ box: BOX, owner: OWNER, for: "probe" });
  handle.step(step, "running");
  const usual = registry.activeFor(BOX)?.steps.find((view) => view.step === step)?.usualMs;
  handle.end(true);
  return usual;
}

describe("the launch registry", () => {
  it("a launch's events are throttled to one a second plus each state change", async () => {
    const { registry } = make();
    const handle = registry.open({ box: BOX, owner: OWNER, for: "s1" });
    handle.step("checks", "running");
    handle.step("checks", "done");
    const kinds = () => sent.map((s) => s.event.kind);
    expect(kinds()).toEqual(["launch", "launch", "launch"]); // open, running, done: each a state change
    sent.length = 0;
    handle.step("image", "running");
    for (let i = 0; i < 5; i++) handle.step("image", "running", { line: `l${i}`, at: clock.now() });
    expect(sent).toHaveLength(1); // the state change; the lines wait
    await clock.advance(1000);
    expect(sent).toHaveLength(2); // one trailing event with the last line
    const last = sent[1]?.event;
    expect(last).toMatchObject({
      kind: "launch",
      launch: {
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "image", detail: { line: "l4", at: expect.any(Number) } }),
        ]),
      },
    });
    await clock.advance(5000);
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.key === OWNER)).toBe(true);
  });

  it("flushes nothing after the end: no launch event follows its own end", async () => {
    const { registry } = make();
    const handle = registry.open({ box: BOX, owner: OWNER, for: "s1" });
    handle.step("image", "running");
    sent.length = 0;
    handle.step("image", "running", { line: "late", at: clock.now() });
    handle.step("image", "running", { line: "later", at: clock.now() });
    handle.end(false, "timeout");
    await clock.advance(10_000);
    const kinds = sent.map((s) => s.event.kind);
    expect(kinds.at(-1)).toBe("end");
    expect(kinds.filter((kind) => kind === "end")).toHaveLength(1);
    expect(sent.at(-1)?.event).toEqual({
      kind: "end",
      id: handle.id,
      done: true,
      ok: false,
      code: "timeout",
    });
    handle.step("vm", "running");
    handle.end(true);
    await clock.advance(10_000);
    expect(sent.at(-1)?.event.kind).toBe("end");
    expect(registry.activeFor(BOX)).toBeNull();
  });

  it("usual is the median of the last 20 runs once there are 3", async () => {
    const { registry } = make();
    await run(registry, "vm", 1000);
    await run(registry, "vm", 9000);
    expect(usualOf(registry, "vm")).toBeNull();
    await run(registry, "vm", 3000);
    expect(usualOf(registry, "vm")).toBe(3000);
    for (let i = 0; i < 20; i++) await run(registry, "vm", 100);
    expect(usualOf(registry, "vm")).toBe(100);
  });

  it("a skipped image is not a sample", async () => {
    const { registry } = make();
    for (let i = 0; i < 4; i++) await run(registry, "image", 0, "skipped");
    expect(db.get("SELECT count(*) AS n FROM launch_steps WHERE step = 'image'")).toEqual({ n: 0 });
    expect(usualOf(registry, "image")).toBeNull();
  });

  it("the table keeps 20 rows per box and step", async () => {
    const { registry } = make();
    for (let i = 0; i < 25; i++) await run(registry, "vm", 10 + i);
    expect(db.get("SELECT count(*) AS n FROM launch_steps WHERE step = 'vm'")).toEqual({ n: 20 });
    expect(db.get("SELECT min(ms) AS m FROM launch_steps WHERE step = 'vm'")).toEqual({ m: 15 });
    const other: BoxRef = { kind: "project", id: "22222222-2222-4222-8222-222222222222" };
    const handle = registry.open({ box: other, owner: OWNER, for: "start" });
    handle.step("vm", "running");
    await clock.advance(5);
    handle.step("vm", "done");
    expect(db.get("SELECT count(*) AS n FROM launch_steps WHERE step = 'vm'")).toEqual({ n: 21 });
  });

  it("the snapshot lists the owner's live launches only, and the owners with a subscription are tracked", () => {
    const { registry, snapshots } = make();
    const other: BoxRef = { kind: "project", id: "22222222-2222-4222-8222-222222222222" };
    registry.open({ box: BOX, owner: OWNER, for: "a" });
    registry.open({ box: other, owner: "owner-2", for: "b" });
    const snap = snapshots.get("launches")?.(OWNER) as Extract<LaunchesStreamEvent, { kind: "snapshot" }>;
    expect(snap.launches.map((launch) => launch.box)).toEqual([BOX]);
    expect(registry.live("owner-2")).toHaveLength(1);
    expect(registry.subscribedOwners()).toEqual([]);
    subscribed.add(OWNER);
    expect(registry.subscribedOwners()).toEqual([OWNER]);
    subscribed.clear();
    expect(registry.subscribedOwners()).toEqual([]);
  });

  it("tells its listeners when a box's launch opens, changes and ends", () => {
    const { registry } = make();
    const told: string[] = [];
    registry.onChange((box) => void told.push(box.id));
    const handle = registry.open({ box: BOX, owner: OWNER, for: "a" });
    handle.step("checks", "running");
    handle.end(true);
    expect(told).toEqual([BOX.id, BOX.id, BOX.id]);
  });

  it("a second open joins the live launch and it ends with the last handle", () => {
    const { registry } = make();
    const first = registry.open({ box: BOX, owner: OWNER, for: "a" });
    const second = registry.open({ box: BOX, owner: OWNER, for: "b" });
    expect(second.id).toBe(first.id);
    first.end(true);
    expect(registry.activeFor(BOX)).not.toBeNull();
    second.end(true);
    expect(registry.activeFor(BOX)).toBeNull();
  });

  it("a joiner that fails does not fail the launch the first one still drives", () => {
    const { registry } = make();
    const first = registry.open({ box: BOX, owner: OWNER, for: "a" });
    const joiner = registry.open({ box: BOX, owner: OWNER, for: "b" });
    first.step("vm", "running");
    sent.length = 0;
    joiner.end(false, "disk_low");
    expect(registry.activeFor(BOX)?.steps.find((s) => s.step === "vm")?.state).toBe("running");
    first.step("vm", "done");
    first.end(true);
    expect(sent.at(-1)?.event).toEqual({ kind: "end", id: first.id, done: true, ok: true });
  });

  it("a launch never ended is closed by the watchdog with timeout and the box leaves starting", async () => {
    const { registry } = make();
    const told: string[] = [];
    registry.onChange((box) => void told.push(box.id));
    const handle = registry.open({ box: BOX, owner: OWNER, for: "a" });
    handle.step("vm", "running");
    await clock.advance(30_000 + 30 * 60_000 + 10 * 60_000 + 60_000 + 60_000 + 30_000 - 1);
    expect(registry.activeFor(BOX)).not.toBeNull();
    await clock.advance(1);
    expect(registry.activeFor(BOX)).toBeNull();
    expect(sent.at(-1)?.event).toEqual({
      kind: "end",
      id: handle.id,
      done: true,
      ok: false,
      code: "timeout",
    });
    expect(told.length).toBeGreaterThan(1);
  });

  it("close clears timers and ends live launches", async () => {
    const { registry } = make();
    const handle = registry.open({ box: BOX, owner: OWNER, for: "a" });
    handle.step("image", "running");
    handle.step("image", "running", { line: "x", at: clock.now() });
    registry.close();
    expect(registry.activeFor(BOX)).toBeNull();
    expect(sent.at(-1)?.event).toMatchObject({ kind: "end", id: handle.id, ok: false });
    expect(clock.pending()).toBe(0);
    const count = sent.length;
    await clock.advance(10_000);
    expect(sent).toHaveLength(count);
  });
});
