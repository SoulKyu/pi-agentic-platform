import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError, type WorkerRecord } from "@pap/contracts";
import { expect, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../clock.ts";
import { createLogger } from "../logger.ts";
import type { WorkerScope } from "../supervisor/scope.ts";
import { spawnWorker, type WorkerHandle } from "../supervisor/worker.ts";

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
if (mode === "setsid-child") {
  // The way Pi's bash tool starts a command: detached, so it leads a session and a group of its own.
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
  send({ type: "grandchild", pid: sleeper.pid });
}
// 1 GiB is the stop: a missing memory limit fails the test with exit code 3 instead of eating the host's memory.
if (mode === "hog") {
  const kept = [];
  const timer = setInterval(() => { if (kept.length >= 64) { clearInterval(timer); process.exit(3); } kept.push(Buffer.alloc(16 * 1024 * 1024, 1)); }, 10);
}
if (mode === "child-hog") {
  const hog = spawn(process.execPath, ["-e", "const k=[];setInterval(()=>{if(k.length>=64)process.exit(3);k.push(Buffer.alloc(16*1024*1024,1))},10)"], { stdio: "ignore" });
  hog.on("exit", (code, signal) => send({ type: "extension_error", extensionPath: "rogue", event: "child_exit", error: String(signal ?? code) }));
}
if (mode === "term-proof-child") {
  // A group of its own and SIGTERM ignored (the disposition survives exec): only SIGKILL ends it.
  const sleeper = spawn("sh", ["-c", "trap '' TERM; exec sleep 300"], { stdio: "ignore", detached: true });
  send({ type: "grandchild", pid: sleeper.pid });
}
if (mode === "stubborn") process.on("SIGTERM", () => {});
if (mode === "garbage") {
  for (const junk of [null, 5, "text", [], {}, { type: 7 }, { type: "response" }, { type: "ready" }, { type: "health" }, { type: "extension_error" }]) send(junk);
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
    if (m.type === "get_state" || m.type === "prompt") held.push({ id: m.id, command: m.type });
    if (m.type === "abort") for (const { id, command } of held.splice(0)) send({ type: "response", id, command, success: true });
  }
  if (mode === "long-strings" && m.type === "get_state") send({ type: "response", id: m.id, command: "get_state", success: false, error: "x".repeat(10000) });
});
keepAlive();
`;

/** Whether a process exists and is not a zombie waiting to be reaped. */
export function alive(pid: number): boolean {
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

/** A pid that may be put behind `-` in kill(2): 0 and 1 would signal our own group or every process. */
export function realPid(pid: number | undefined): number {
  expect(pid).toBeGreaterThan(1);
  return pid as number;
}

export const signalGroupOf = (handle: WorkerHandle, signal: NodeJS.Signals): void => {
  process.kill(-realPid(handle.pid), signal);
};

/** What the rogue worker sent as Pi events of one type, in order. */
export const eventsOf = (records: WorkerRecord[], type: string): Array<Record<string, unknown>> =>
  records.flatMap((record) =>
    record.type === "pi_event" && record.event.type === type ? [record.event] : [],
  );

export const waitForReady = (records: WorkerRecord[]) =>
  vi.waitFor(() => expect(records.some((record) => record.type === "ready")).toBe(true), { timeout: 20_000 });

/** The code a request was rejected with, or "resolved". */
export const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );

export interface RogueBed {
  readonly root: string;
  readonly clock: FakeClock;
  readonly logged: Array<{ msg: string; fields: unknown }>;
  logger(): ReturnType<typeof createLogger>;
  rogue(mode: string, options?: { cwd?: string; scope?: WorkerScope }): WorkerHandle;
  collect(handle: WorkerHandle): WorkerRecord[];
  /** The pid the rogue worker reported as its child; the bed kills it at the end if it is still there. */
  grandchildOf(records: WorkerRecord[]): Promise<number>;
  track(pid: number): void;
  dispose(): Promise<void>;
}

/** A temporary directory, a fake clock and the workers started in them, all cleaned up by `dispose`. */
export function createRogueBed(): RogueBed {
  const root = mkdtempSync(join(tmpdir(), "pap-rogue-"));
  writeFileSync(join(root, "rogue.mjs"), ROGUE);
  const clock = createFakeClock();
  const logged: Array<{ msg: string; fields: unknown }> = [];
  const handles: WorkerHandle[] = [];
  const reported = new Set<WorkerHandle>();
  const tracked: number[] = [];
  const logger = () =>
    createLogger({
      level: "debug",
      clock,
      write: (line) => {
        const { msg, ...fields } = JSON.parse(line) as { msg: string };
        logged.push({ msg, fields });
      },
    });
  return {
    root,
    clock,
    logged,
    logger,
    rogue(mode, options = {}) {
      const handle = spawnWorker({
        entry: join(root, "rogue.mjs"),
        execArgv: [],
        cwd: options.cwd ?? root,
        env: {
          PATH: process.env.PATH,
          ROGUE: mode,
          ...(options.scope ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        },
        clock,
        logger: logger(),
        ...(options.scope ? { scope: options.scope } : {}),
      });
      handles.push(handle);
      void handle.exited.then(() => reported.add(handle));
      return handle;
    },
    collect(handle) {
      const records: WorkerRecord[] = [];
      handle.onRecord((record) => records.push(record));
      return records;
    },
    async grandchildOf(records) {
      await vi.waitFor(() => expect(eventsOf(records, "grandchild")).toHaveLength(1));
      const pid = realPid(Number(eventsOf(records, "grandchild")[0]?.pid));
      tracked.push(pid);
      return pid;
    },
    track: (pid) => void tracked.push(pid),
    async dispose() {
      // Only what is still there: a pid whose exit was reported may belong to someone else by now.
      for (const handle of handles) {
        const pid = handle.pid;
        if (pid !== undefined && pid > 1 && !reported.has(handle) && alive(pid))
          process.kill(-pid, "SIGKILL");
      }
      for (const pid of tracked) if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
      await Promise.all(handles.map((handle) => handle.exited));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
