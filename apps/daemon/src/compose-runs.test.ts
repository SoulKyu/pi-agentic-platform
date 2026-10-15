import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { M10Core } from "./compose-automation.ts";
import { composeRuns, registerAttachmentCleanup } from "./compose-runs.ts";
import { loadConfig } from "./kernel/config.ts";
import { createOutbox, enqueueEffect } from "./kernel/outbox/index.ts";
import { createStreamHub } from "./kernel/ws/stream-hub.ts";
import { openRunsBed, type RunsBed } from "./modules/runs/testing/bed.ts";
import { assistantEnd } from "./modules/runs/testing/events.ts";

let bed: RunsBed | undefined;
afterEach(() => {
  bed?.close();
  bed = undefined;
});

function coreOf(open: RunsBed, readOnly = false, extraEnv: Record<string, string> = {}): M10Core {
  const home = join(open.dir, ".pap");
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  return {
    db: open.db,
    clock: open.clock,
    logger: open.logger,
    readOnly,
    hub: createStreamHub(undefined, open.clock),
    env: {},
    config: loadConfig({
      argv: [],
      env: { PAP_HOME: home, PI_CODING_AGENT_DIR: join(open.dir, ".pi", "agent"), ...extraEnv },
      cwd: open.dir,
      homedir: open.dir,
      totalMemMb: 16_384,
      piHostEntry: "/x/main.js",
      piHostExecArgv: [],
      staticRoot: null,
    }),
  };
}
const logFile = (open: RunsBed) => join(open.dir, ".pap", "logs", "runs.jsonl");
const seedRunning = (open: RunsBed) =>
  open.db.run(
    "INSERT INTO runs (id, owner_id, session_id, origin, status, started_at) VALUES ('old', 'u1', 's0', 'user', 'running', 1)",
  );
const statusOf = (open: RunsBed) =>
  open.db.get<{ status: string }>("SELECT status FROM runs WHERE id = 'old'")?.status;

describe("composeRuns", () => {
  it("tells the summary whether /metrics and the OTLP export are on, by host only", () => {
    bed = openRunsBed();
    const off = composeRuns(coreOf(bed)).service.port.summary("u1", "today", "UTC");
    expect([off.metrics, off.otlpHost]).toEqual([false, null]);
    const on = composeRuns(
      coreOf(bed, false, {
        PAP_METRICS_TOKEN: "m".repeat(40),
        PAP_OTLP_ENDPOINT: "https://otel.example.net:4318/v1",
        PAP_OTLP_HEADERS: "Authorization=Bearer-secret-value",
      }),
    ).service.port.summary("u1", "today", "UTC");
    expect([on.metrics, on.otlpHost]).toEqual([true, "otel.example.net:4318"]);
    expect(JSON.stringify(on)).not.toMatch(/secret|mmmm|v1/);
  });

  it("recovers the runs a crash left open before it returns, with their lines", () => {
    bed = openRunsBed();
    seedRunning(bed);
    const runs = composeRuns(coreOf(bed));
    expect(runs).toBeDefined();
    expect(statusOf(bed)).toBe("interrupted");
    const lines = readFileSync(logFile(bed), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      v: 1,
      id: "old",
      status: "interrupted",
      errorClass: "crash",
      ts: new Date(bed.clock.now()).toISOString(),
    });
    expect(statSync(logFile(bed)).mode & 0o777).toBe(0o600);
  });

  it("exports one line per ended run, through the observer", () => {
    bed = openRunsBed();
    const runs = composeRuns(coreOf(bed));
    const session = { id: "s1", ownerId: "u1" };
    runs.observer.onRecord(session, "run_start", { origin: "user" }, null);
    runs.observer.onEvent("s1", assistantEnd({ input: 4, cost: 0.5 }, { model: 'bad"model' }));
    expect(existsSync(logFile(bed))).toBe(false);
    runs.observer.onRecord(session, "run_end", { aborted: false }, { billing: "subscription" });
    const lines = readFileSync(logFile(bed), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      status: "completed",
      billing: "subscription",
      model: "other",
      costUsd: 0.5,
      tokens: { input: 4 },
    });
  });

  it("writes nothing and arms nothing in read-only mode", () => {
    bed = openRunsBed();
    seedRunning(bed);
    const runs = composeRuns(coreOf(bed, true));
    expect(statusOf(bed)).toBe("running");
    expect(existsSync(logFile(bed))).toBe(false);
    expect(bed.clock.pending()).toBe(0);
    runs.observer.onRecord({ id: "s1", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    runs.observer.onRecord({ id: "s1", ownerId: "u1" }, "run_end", { aborted: false }, null);
    expect(bed.db.all("SELECT 1 FROM runs")).toHaveLength(1);
    expect(existsSync(logFile(bed))).toBe(false);
    expect(runs.service.port.sessionCost("s1")).toBeNull();
  });

  it("keeps a run's row when the file cannot be written, and logs it once", () => {
    bed = openRunsBed();
    const core = coreOf(bed);
    mkdirSync(logFile(bed));
    const runs = composeRuns(core);
    const session = { id: "s1", ownerId: "u1" };
    runs.observer.onRecord(session, "run_start", { origin: "user" }, null);
    runs.observer.onRecord(session, "run_end", { aborted: false }, null);
    runs.observer.onRecord(session, "run_start", { origin: "user" }, null);
    runs.observer.onRecord(session, "run_end", { aborted: false }, null);
    expect(bed.db.all<{ status: string }>("SELECT status FROM runs").map((row) => row.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(bed.logs.filter((line) => line.msg === "runs_export_failed")).toHaveLength(1);
  });
});

describe("registerAttachmentCleanup", () => {
  const DAY = 86_400_000;
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const setup = () => {
    const open = openRunsBed();
    bed = open;
    const core = coreOf(open);
    const root = join(core.config.home, "attachments");
    mkdirSync(root, { recursive: true });
    const outbox = createOutbox({ db: open.db, clock: open.clock, logger: open.logger, readOnly: false });
    const activity = new Map<string, number>();
    registerAttachmentCleanup(core, outbox, { lastActivityAt: (id) => activity.get(id) ?? null });
    const folder = (id: string, mtimeMs = open.clock.now()) => {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, "a.png"), "x");
      utimesSync(join(root, id, "a.png"), mtimeMs / 1000, mtimeMs / 1000);
      utimesSync(join(root, id), mtimeMs / 1000, mtimeMs / 1000);
    };
    const enqueue = () =>
      enqueueEffect(
        open.db,
        { kind: "attachment.cleanup", ownerId: null, payload: { day: "2026-10-14" } },
        open.clock.now(),
      );
    return { root, outbox, activity, folder, enqueue };
  };
  const row = () =>
    bed?.db.get<{ status: string; next_at: number; attempts: number }>(
      "SELECT status, next_at, attempts FROM outbox WHERE kind = 'attachment.cleanup'",
    );

  it("removes the folders of sessions idle for 30 days, and of rowless folders with an old mtime", async () => {
    const { root, outbox, activity, folder, enqueue } = setup();
    const now = bed?.clock.now() ?? 0;
    folder(uuid(1), now - 31 * DAY);
    activity.set(uuid(1), now - 31 * DAY);
    folder(uuid(2), now - 31 * DAY);
    activity.set(uuid(2), now - 29 * DAY);
    folder(uuid(3), now - 31 * DAY);
    folder(uuid(4), now - 1 * DAY);
    enqueue();
    await outbox.drain();
    expect([uuid(1), uuid(3)].map((id) => existsSync(join(root, id)))).toEqual([false, false]);
    expect([uuid(2), uuid(4)].map((id) => existsSync(join(root, id)))).toEqual([true, true]);
    expect(row()?.status).toBe("done");
  });

  it("keeps the folder of an idle session whose attachment was copied less than 30 days ago", async () => {
    const { root, outbox, activity, folder, enqueue } = setup();
    const now = bed?.clock.now() ?? 0;
    folder(uuid(1), now - 40 * DAY);
    activity.set(uuid(1), now - 40 * DAY);
    writeFileSync(join(root, uuid(1), "fresh.png"), "x");
    utimesSync(join(root, uuid(1), "fresh.png"), (now - 1 * DAY) / 1000, (now - 1 * DAY) / 1000);
    utimesSync(join(root, uuid(1)), (now - 40 * DAY) / 1000, (now - 40 * DAY) / 1000);
    folder(uuid(2), now - 40 * DAY);
    activity.set(uuid(2), now - 40 * DAY);
    enqueue();
    await outbox.drain();
    expect([uuid(1), uuid(2)].map((id) => existsSync(join(root, id)))).toEqual([true, false]);
  });

  it("settles defer one minute later after a pass with more to do, not as an attempt, and the next run continues", async () => {
    const { root, outbox, activity, folder, enqueue } = setup();
    const old = (bed?.clock.now() ?? 0) - 40 * DAY;
    for (let i = 0; i < 60; i++) {
      folder(uuid(i), old);
      activity.set(uuid(i), old);
    }
    enqueue();
    await outbox.drain();
    expect(row()).toMatchObject({
      status: "pending",
      next_at: (bed?.clock.now() ?? 0) + 60_000,
      attempts: 0,
    });
    expect(readdirSync(root)).toHaveLength(10);
    await bed?.clock.advance(60_000);
    await outbox.drain();
    expect(readdirSync(root)).toHaveLength(0);
    expect(row()?.status).toBe("done");
  });
});
