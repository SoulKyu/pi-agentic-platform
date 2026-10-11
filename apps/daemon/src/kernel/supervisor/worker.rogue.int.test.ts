import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PapError, type WorkerRecord } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../clock.ts";
import { createLogger } from "../logger.ts";
import {
  OUTPUT_TAIL_BYTES,
  MAX_SHUTDOWN_GRACE_MS,
  MAX_WORKER_STRING,
  spawnWorker,
  type WorkerHandle,
} from "./worker.ts";

// A worker that misbehaves on purpose. Each mode is one way a real worker could go wrong.
const ROGUE = `
import { spawn } from "node:child_process";
const mode = process.env.ROGUE;
const ready = { type: "ready", sessionFile: "/f.jsonl", sessionId: "s", piVersion: "1" };
const send = (record) => { try { process.send(record); } catch {} };
const held = [];
const keepAlive = () => setInterval(() => {}, 1000);
if (mode === "stubborn" || mode === "orphan-maker") {
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
  send({ type: "grandchild", pid: sleeper.pid });
}
if (mode === "stubborn") process.on("SIGTERM", () => {});
if (mode === "garbage") {
  for (const junk of [null, 5, "text", [], {}, { type: 7 }, { type: "response" }, { type: "ready" }, { type: "audit", entry: {} }, { type: "extension_error" }]) send(junk);
}
if (mode === "unknown-response") send({ type: "response", id: "never-asked", command: "get_state", success: true });
if (mode === "flood") for (let i = 0; i < 20000; i++) send({ type: "message_update", i });
if (mode === "loud") {
  const chunk = "x".repeat(65536);
  let left = 800;
  const pump = () => {
    if (left-- === 0) { process.stderr.write("TAIL-MARKER\\n", () => { send(ready); }); return; }
    process.stderr.write(chunk, pump);
  };
  pump();
} else if (mode === "disconnect") {
  send(ready);
  setTimeout(() => process.disconnect(), 50);
} else {
  send(ready);
}
if (mode === "long-strings") {
  send({ type: "extension_error", extensionPath: "p".repeat(10000), event: "e".repeat(10000), error: "x".repeat(10000) });
}
process.on("message", (m) => {
  if (mode === "orphan-maker" && m.type === "shutdown") process.exit(0);
  if (mode === "echo" || mode === "stubborn") send({ type: "echo", record: m });
  if (mode === "late") {
    if (m.type === "get_state") held.push(m.id);
    if (m.type === "abort") for (const id of held) send({ type: "response", id, command: "get_state", success: true });
  }
  if (mode === "long-strings" && m.type === "get_state") send({ type: "response", id: m.id, command: "get_state", success: false, error: "x".repeat(10000) });
});
keepAlive();
`;

let root: string;
let clock: FakeClock;
let handles: WorkerHandle[];
let logged: Array<{ msg: string; fields: unknown }>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-rogue-"));
  writeFileSync(join(root, "rogue.mjs"), ROGUE);
  clock = createFakeClock();
  handles = [];
  logged = [];
});
afterEach(async () => {
  for (const handle of handles) if (handle.pid !== undefined) killGroup(handle.pid);
  await Promise.all(handles.map((handle) => handle.exited));
  rmSync(root, { recursive: true, force: true });
});

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function logger() {
  return createLogger({
    level: "debug",
    clock,
    write: (line) => {
      const { msg, ...fields } = JSON.parse(line) as { msg: string };
      logged.push({ msg, fields });
    },
  });
}

function rogue(mode: string, options: { cwd?: string } = {}): WorkerHandle {
  const handle = spawnWorker({
    entry: join(root, "rogue.mjs"),
    execArgv: [],
    cwd: options.cwd ?? root,
    env: { PATH: process.env.PATH, ROGUE: mode },
    clock,
    logger: logger(),
  });
  handles.push(handle);
  return handle;
}

function collect(handle: WorkerHandle): WorkerRecord[] {
  const records: WorkerRecord[] = [];
  handle.onRecord((record) => records.push(record));
  return records;
}

const waitForReady = (records: WorkerRecord[]) =>
  vi.waitFor(() => expect(records.some((record) => record.type === "ready")).toBe(true), { timeout: 20_000 });

function alive(pid: number): boolean {
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

// What the rogue worker sent as Pi events of one type, in order.
const eventsOf = (records: WorkerRecord[], type: string): Array<Record<string, unknown>> =>
  records.flatMap((record) =>
    record.type === "pi_event" && record.event.type === type ? [record.event] : [],
  );

async function grandchildOf(records: WorkerRecord[]): Promise<number> {
  await vi.waitFor(() => expect(eventsOf(records, "grandchild")).toHaveLength(1));
  return Number(eventsOf(records, "grandchild")[0]?.pid);
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );

describe("a worker that sends garbage", () => {
  it("has every invalid record dropped and counted, and the valid ones delivered", async () => {
    const handle = rogue("garbage");
    const records = collect(handle);
    await waitForReady(records);
    expect(records.map((record) => record.type)).toEqual(["ready"]);
    expect(handle.stats().droppedRecords).toBe(10);
    expect(logged.filter((entry) => entry.msg === "worker_record_dropped").length).toBeLessThan(10);
  });

  it("has a response nobody asked for dropped and counted", async () => {
    const handle = rogue("unknown-response");
    await waitForReady(collect(handle));
    expect(handle.stats().unknownResponses).toBe(1);
  });

  it("clips the strings of extension errors and of failed responses", async () => {
    const handle = rogue("long-strings");
    const records = collect(handle);
    await vi.waitFor(() => expect(records.some((record) => record.type === "extension_error")).toBe(true));
    const failure = records.find((record) => record.type === "extension_error");
    expect(failure).toMatchObject({ type: "extension_error" });
    for (const field of ["extensionPath", "event", "error"] as const) {
      expect((failure as unknown as Record<string, string>)[field]?.length).toBeLessThanOrEqual(
        MAX_WORKER_STRING + 1,
      );
    }
    const response = await handle.request({ type: "get_state" }, 5000);
    expect(response.success).toBe(false);
    expect(response.error?.length).toBeLessThanOrEqual(MAX_WORKER_STRING + 1);
  });

  it("does not let a throwing listener hurt the daemon, the other listeners or the worker", async () => {
    const handle = rogue("flood");
    handle.onRecord(() => {
      throw new Error("listener bug");
    });
    const records = collect(handle);
    await waitForReady(records);
    expect(records).toHaveLength(20_001);
    expect(handle.stats().listenerErrors).toBe(20_001);
    expect(logged.filter((entry) => entry.msg === "worker_listener_failed").length).toBeLessThan(20);
    expect(handle.stats().droppedRecords).toBe(0);
  });
});

describe("a worker that floods", () => {
  it("keeps only the last bytes of its output, and the exit is reported after the last of it", async () => {
    const handle = rogue("loud");
    await waitForReady(collect(handle));
    const tail = handle.outputTail();
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(tail.endsWith("TAIL-MARKER\n")).toBe(true);
    const stopping = handle.stop();
    await clock.advance(2000);
    await clock.advance(3000);
    await stopping;
    expect(Buffer.byteLength(handle.outputTail())).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
  });

  it("never holds a request longer than its timeout, and forgets it", async () => {
    const handle = rogue("late");
    await waitForReady(collect(handle));
    const first = rejection(handle.request({ type: "get_state" }, 1000));
    expect(handle.stats().pendingRequests).toBe(1);
    await clock.advance(1000);
    expect(await first).toBe("worker_failed");
    expect(handle.stats().pendingRequests).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("counts the answer that comes after the timeout", async () => {
    const handle = rogue("late");
    await waitForReady(collect(handle));
    const late = rejection(handle.request({ type: "get_state" }, 1000));
    await clock.advance(1000);
    expect(await late).toBe("worker_failed");
    const poke = rejection(handle.request({ type: "abort" }, 60_000));
    await vi.waitFor(() => expect(handle.stats().unknownResponses).toBe(1));
    expect(handle.stats().pendingRequests).toBe(1);
    void handle.stop();
    await clock.advance(5000);
    expect(await poke).toBe("worker_failed");
    expect(handle.stats().pendingRequests).toBe(0);
  });
});

describe("a worker that will not stop", () => {
  it("is escalated to SIGTERM on the group, then SIGKILL, and its whole group dies", async () => {
    const handle = rogue("stubborn");
    const records = collect(handle);
    await waitForReady(records);
    const sleeper = await grandchildOf(records);
    expect(alive(sleeper)).toBe(true);
    const stopped = handle.stop();
    await clock.advance(2000);
    await vi.waitFor(() => expect(eventsOf(records, "echo")).toHaveLength(1));
    expect(handle.pid !== undefined && alive(handle.pid)).toBe(true);
    await clock.advance(3000);
    expect(await stopped).toMatchObject({ signal: "SIGKILL", cause: "killed" });
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false));
  });

  it("is killed when it is stopped by SIGSTOP and cannot even read the shutdown", async () => {
    const handle = rogue("echo");
    await waitForReady(collect(handle));
    process.kill(-(handle.pid ?? 0), "SIGSTOP");
    const stopped = handle.stop();
    await clock.advance(2000);
    await clock.advance(3000);
    expect((await stopped).cause).toBe("killed");
  });

  it("is taken down when it closes the channel and stays alive", async () => {
    const handle = rogue("disconnect");
    const records = collect(handle);
    await waitForReady(records);
    await vi.waitFor(() => expect(handle.send({ type: "get_state", id: "x" })).toBe(false));
    expect(await rejection(handle.request({ type: "get_state" }))).toBe("worker_failed");
    await clock.advance(2000);
    expect(await handle.exited).toMatchObject({ signal: "SIGTERM", cause: "signal" });
  });

  it("has what it left behind swept when it exits on its own", async () => {
    const handle = rogue("orphan-maker");
    const records = collect(handle);
    await waitForReady(records);
    const sleeper = await grandchildOf(records);
    expect(alive(sleeper)).toBe(true);
    expect((await handle.stop()).cause).toBe("clean");
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false));
  });

  it("never asks the worker for more than 30 s of grace", async () => {
    const handle = rogue("echo");
    const records = collect(handle);
    await waitForReady(records);
    handle.send({ type: "shutdown", graceMs: 10 ** 9 });
    await vi.waitFor(() => expect(eventsOf(records, "echo")).toHaveLength(1));
    expect(eventsOf(records, "echo")[0]?.record).toEqual({
      type: "shutdown",
      graceMs: MAX_SHUTDOWN_GRACE_MS,
    });
    void handle.stop();
    await clock.advance(2000);
    await handle.exited;
  });
});

describe("a worker that cannot start", () => {
  it("reports a spawn failure when its directory does not exist", async () => {
    const handle = rogue("echo", { cwd: join(root, "missing") });
    expect(await handle.exited).toMatchObject({ cause: "spawn_failure", code: null, signal: null });
    expect(handle.send({ type: "get_state", id: "x" })).toBe(false);
    expect(await rejection(handle.request({ type: "get_state" }))).toBe("worker_failed");
    expect((await handle.stop()).cause).toBe("spawn_failure");
  });

  it("reports a spawn failure instead of throwing when the options are unusable", async () => {
    const handle = spawnWorker({
      entry: join(root, "rogue.mjs"),
      execArgv: [],
      cwd: root,
      env: { BAD: "a\0b" },
      clock,
      logger: logger(),
    });
    expect(await handle.exited).toMatchObject({ cause: "spawn_failure" });
    expect(handle.pid).toBeUndefined();
    expect(logged.map((entry) => entry.msg)).toContain("worker_spawn_failed");
  });

  it("reports the exit code of an entry that cannot be loaded", async () => {
    const handle = spawnWorker({
      entry: join(root, "absent.mjs"),
      execArgv: [],
      cwd: root,
      env: { PATH: process.env.PATH },
      clock,
      logger: logger(),
    });
    handles.push(handle);
    expect(await handle.exited).toMatchObject({ code: 1, cause: "exit_code" });
    expect(handle.outputTail()).toContain("absent.mjs");
  });
});

describe("a daemon that dies", () => {
  it("takes the process group of every live worker with it", async () => {
    const supervisor = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const parent = join(root, "parent.mjs");
    writeFileSync(
      parent,
      `import { spawnWorker } from ${JSON.stringify(supervisor)};
const handle = spawnWorker({ entry: ${JSON.stringify(join(root, "rogue.mjs"))}, execArgv: [], cwd: ${JSON.stringify(root)}, env: { PATH: process.env.PATH, ROGUE: "stubborn" },
  clock: { now: Date.now, setTimeout: (fn, ms) => ({ id: 0, t: setTimeout(fn, ms).unref() }), clearTimeout: () => {}, sleep: () => Promise.resolve() },
  logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
let sleeper;
handle.onRecord((record) => {
  if (record.type === "pi_event" && record.event.type === "grandchild") sleeper = record.event.pid;
  if (record.type === "ready") { console.log(JSON.stringify({ worker: handle.pid, sleeper })); process.exit(0); }
});
`,
    );
    const run = spawnSync(
      process.execPath,
      ["--conditions=development", "--disable-warning=ExperimentalWarning", parent],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    const { worker, sleeper } = JSON.parse(run.stdout) as { worker: number; sleeper: number };
    try {
      await vi.waitFor(() => {
        expect(alive(worker)).toBe(false);
        expect(alive(sleeper)).toBe(false);
      });
    } finally {
      for (const pid of [worker, sleeper]) killGroup(pid);
    }
  });
});
