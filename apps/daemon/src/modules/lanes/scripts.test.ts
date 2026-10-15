import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { migrate, KERNEL_MIGRATIONS } from "../../kernel/db/migrate.ts";
import type { Db } from "../../kernel/db/database.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { CUT_LINE } from "./script-log.ts";
import { SCRIPT_LOG_BYTES } from "./script-spawn.ts";
import { insertLane } from "./testing/lane-rows.ts";
import { createFakes, runnerOf, tempHome } from "./testing/script-fakes.ts";

let db: Db;
let clock: FakeClock;
let home: ReturnType<typeof tempHome>;
const logs = captureLogger();

beforeEach(() => {
  home = tempHome();
  clock = createFakeClock();
  logs.lines.length = 0;
  db = migrate({
    dbPath: join(home.dir, "state.db"),
    backupsDir: join(home.dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock,
    logger: logs.logger,
  }).db;
});
afterEach(() => {
  db.close();
  home.dispose();
});

const setup = (fakes = createFakes(), extra = {}, approved?: Parameters<typeof runnerOf>[0]["approved"]) => ({
  fakes,
  runner: runnerOf({
    db,
    clock,
    logger: logs.logger,
    home: join(home.dir, "pap"),
    fakes,
    extra,
    ...(approved ? { approved } : {}),
  }),
});
const columns = (laneId: string) =>
  db.get<Record<string, unknown>>(
    "SELECT setup_state, setup_exit, test_state, script_pgid, script_proc FROM lanes WHERE id = $laneId",
    { laneId },
  );

describe("ScriptRunner.run", () => {
  it("answers none when the project has no script of that kind", async () => {
    const lane = insertLane(db);
    const { runner, fakes } = setup(undefined, {}, async () => ({ ok: false, reason: "none" }));
    expect(await runner.run(lane, "setup")).toEqual({ ok: false, reason: "none" });
    expect(fakes.children).toHaveLength(0);
  });

  it("answers unapproved, records the state, and spawns nothing", async () => {
    const lane = insertLane(db);
    const { runner, fakes } = setup(undefined, {}, async () => ({ ok: false, reason: "unapproved" }));
    expect(await runner.run(lane, "setup")).toEqual({ ok: false, reason: "unapproved" });
    expect(runner.state(lane.id, "setup").state).toBe("unapproved");
    expect(fakes.children).toHaveLength(0);
  });

  it("writes running BEFORE the spawn, the group and boot tag right after, then ok and clears the columns", async () => {
    const lane = insertLane(db);
    let seenAtSpawn: unknown;
    const fakes = createFakes(() => {
      seenAtSpawn = columns(lane.id);
    });
    fakes.probe.starts.set(40_000, "777");
    const { runner } = setup(fakes);
    expect(await runner.run(lane, "setup")).toEqual({ ok: true });
    expect(seenAtSpawn).toMatchObject({ setup_state: "running", script_pgid: null });
    expect(columns(lane.id)).toMatchObject({ script_pgid: 40_000, script_proc: "boot-1:777" });
    expect(fakes.tracked.has(40_000)).toBe(true);
    const child = fakes.child(0);
    expect(child.cwd).toBe(lane.worktree);
    expect(child.spec.args).toContain("echo hi");
    expect(child.spec.env).toMatchObject({ PAP_LANE_ID: lane.id });
    expect(child.spec.env.SSH_AUTH_SOCK).toBeUndefined();
    child.end({ code: 0, signal: null });
    await vi_waitFor(() => runner.state(lane.id, "setup").state === "ok");
    expect(columns(lane.id)).toMatchObject({ setup_exit: 0, script_pgid: null, script_proc: null });
    expect(fakes.tracked.size).toBe(0);
  });

  it("records failed with the exit code, and passed for a test", async () => {
    const a = insertLane(db);
    const b = insertLane(db);
    const { runner, fakes } = setup();
    await runner.run(a, "setup");
    await runner.run(b, "test");
    fakes.child(0).end({ code: 2, signal: null });
    fakes.child(1).end({ code: 0, signal: null });
    await vi_waitFor(() => runner.state(b.id, "test").state === "passed");
    expect(runner.state(a.id, "setup")).toEqual({ state: "failed", exitCode: 2 });
  });

  it("keeps the archive state in memory", async () => {
    const lane = insertLane(db);
    const { runner, fakes } = setup();
    await runner.run(lane, "archive");
    expect(runner.state(lane.id, "archive").state).toBe("running");
    fakes.child(0).end({ code: 0, signal: null });
    await vi_waitFor(() => runner.state(lane.id, "archive").state === "ok");
    expect(runner.state(lane.id, "setup").state).toBe("none");
  });

  it("past 30 minutes: SIGTERM to the group, SIGKILL 5 s later, failed with exitCode null", async () => {
    const lane = insertLane(db);
    const { runner, fakes } = setup();
    await runner.run(lane, "setup");
    const pid = fakes.child(0).pid;
    await clock.advance(30 * 60_000 - 1);
    expect(fakes.signals).toEqual([]);
    await clock.advance(1);
    expect(fakes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    await clock.advance(4999);
    expect(fakes.signals).toHaveLength(1);
    await clock.advance(1);
    expect(fakes.signals).toEqual([
      { pid, signal: "SIGTERM" },
      { pid, signal: "SIGKILL" },
    ]);
    fakes.child(0).end({ code: null, signal: "SIGKILL" });
    await vi_waitFor(() => runner.state(lane.id, "setup").state === "failed");
    expect(runner.state(lane.id, "setup").exitCode).toBeNull();
  });

  it.each([
    ["traps SIGTERM and exits 0", 0],
    ["exits 143 on SIGTERM", 143],
  ])(
    "records a run past its deadline as failed with exitCode null when the script %s",
    async (_name, code) => {
      const lane = insertLane(db);
      const { runner, fakes } = setup();
      await runner.run(lane, "test");
      await clock.advance(15 * 60_000);
      fakes.child(0).end({ code, signal: null });
      await vi_waitFor(() => runner.state(lane.id, "test").state === "failed");
      expect(runner.state(lane.id, "test")).toEqual({ state: "failed", exitCode: null });
    },
  );

  it("uses 5 minutes for archive and 15 for test", async () => {
    const a = insertLane(db);
    const t = insertLane(db);
    const { runner, fakes } = setup();
    await runner.run(a, "archive");
    await runner.run(t, "test");
    await clock.advance(5 * 60_000);
    expect(fakes.signals).toEqual([{ pid: fakes.child(0).pid, signal: "SIGTERM" }]);
    await clock.advance(10 * 60_000);
    expect(fakes.signals.filter((s) => s.pid === fakes.child(1).pid && s.signal === "SIGTERM")).toHaveLength(
      1,
    );
  });

  it("refuses a second run on the same lane while one runs", async () => {
    const lane = insertLane(db);
    const { runner, fakes } = setup();
    await runner.run(lane, "setup");
    expect(await runner.run(lane, "test")).toEqual({ ok: false, reason: "running" });
    expect(fakes.children).toHaveLength(1);
    fakes.child(0).end({ code: 0, signal: null });
    await vi_waitFor(() => runner.state(lane.id, "setup").state === "ok");
    expect(await runner.run(lane, "test")).toEqual({ ok: true });
  });

  it("judges the approval again right before the spawn: a text changed meanwhile never runs", async () => {
    const first = insertLane(db);
    const second = insertLane(db);
    let approved = true;
    const { runner, fakes } = setup(undefined, { perOwner: 1 }, async () =>
      approved ? { ok: true, text: "echo hi" } : { ok: false, reason: "unapproved" },
    );
    await runner.run(first, "setup");
    await runner.run(second, "setup");
    expect(runner.state(second.id, "setup").state).toBe("queued");
    approved = false;
    fakes.child(0).end({ code: 0, signal: null });
    await vi_waitFor(() => runner.state(second.id, "setup").state === "unapproved");
    expect(fakes.children).toHaveLength(1);
  });

  it("stops writing a log past 5 MiB, ends it with the cut line, and logs no output", async () => {
    const lane = insertLane(db);
    const { runner, fakes } = setup();
    await runner.run(lane, "setup");
    const child = fakes.child(0);
    const block = "x".repeat(1024 * 1024);
    for (let i = 0; i < 6; i++) child.emit(block);
    child.emit("SECRET-OUTPUT-LINE");
    child.end({ code: 0, signal: null });
    await vi_waitFor(() => runner.state(lane.id, "setup").state === "ok");
    const file = join(home.dir, "pap", "lanes", lane.id, "setup.log");
    const text = readFileSync(file, "utf8");
    expect(text.endsWith(`\n${CUT_LINE}\n`)).toBe(true);
    expect(text.length).toBe(SCRIPT_LOG_BYTES + CUT_LINE.length + 2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home.dir, "pap", "lanes", lane.id)).mode & 0o777).toBe(0o700);
    const ended = logs.lines.find((line) => line.msg === "lane_script_ended");
    expect(ended).toMatchObject({ laneId: lane.id, kind: "setup", code: 0, logBytes: 6 * 1024 * 1024 + 18 });
    expect(logs.lines.some((line) => JSON.stringify(line).includes("SECRET-OUTPUT"))).toBe(false);
    expect(runner.readLog("u1", lane.id, "setup", 0).capped).toBe(true);
  });

  it("replaces the log of a kind at each run, and deleteLogs removes the lane's folder", async () => {
    const lane = insertLane(db);
    const { runner, fakes } = setup();
    await runner.run(lane, "setup");
    fakes.child(0).emit("first");
    fakes.child(0).end({ code: 0, signal: null });
    await vi_waitFor(() => runner.state(lane.id, "setup").state === "ok");
    await runner.run(lane, "setup");
    fakes.child(1).emit("second");
    fakes.child(1).end({ code: 0, signal: null });
    const dir = join(home.dir, "pap", "lanes", lane.id);
    await vi_waitFor(() => readFileSync(join(dir, "setup.log"), "utf8") === "second");
    runner.deleteLogs(lane.id);
    expect(existsSync(dir)).toBe(false);
  });

  it("marks a failed spawn failed and leaves no group behind", async () => {
    const lane = insertLane(db);
    const fakes = createFakes();
    const { runner } = setup({
      ...fakes,
      spawn: () => {
        throw new Error("boom");
      },
    } as never);
    expect(await runner.run(lane, "setup")).toEqual({ ok: true });
    expect(runner.state(lane.id, "setup").state).toBe("failed");
    expect(columns(lane.id)).toMatchObject({ script_pgid: null });
  });

  it("shutdown kills what runs (SIGTERM, 2 s, SIGKILL) and interrupts it; later runs are refused", async () => {
    const lane = insertLane(db);
    const { runner, fakes } = setup();
    await runner.run(lane, "setup");
    const pid = fakes.child(0).pid;
    const stopped = runner.shutdown();
    expect(fakes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    await clock.advance(2000);
    expect(fakes.signals.at(1)).toEqual({ pid, signal: "SIGKILL" });
    fakes.child(0).end({ code: null, signal: "SIGKILL" });
    await stopped;
    expect(runner.state(lane.id, "setup").state).toBe("interrupted");
    await expect(runner.run(lane, "test")).rejects.toMatchObject({ code: "capacity" });
  });
});

const vi_waitFor = (check: () => boolean): Promise<void> =>
  vi.waitFor(() => expect(check()).toBe(true), { timeout: 2000 });
