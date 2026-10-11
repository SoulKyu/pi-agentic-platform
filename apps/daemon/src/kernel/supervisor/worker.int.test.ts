import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRecord } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { signalGroupOf } from "../testing/rogue-bed.ts";
import { workerEnv } from "./env.ts";
import { describeExit } from "./exit.ts";
import { spawnWorker, type WorkerHandle } from "./worker.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];
let root: string;
let worker: WorkerHandle | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-supervisor-"));
  for (const dir of ["agent", "work", "pap", "home"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "hello" }] }));
});
afterEach(async () => {
  const stopped = worker;
  worker = undefined;
  if (stopped) await stopped.stop();
  rmSync(root, { recursive: true, force: true });
  // A connection the guard refused may have been swallowed by the code that tried it: the log still says so.
  if (stopped) expect(stopped.outputTail()).not.toContain("pap-network-guard: blocked");
});

function launch(
  policy: unknown = { profile: "interactive", approvalMode: "auto-accept-edits" },
): WorkerHandle {
  const handle = spawnWorker({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    cwd: join(root, "work"),
    env: workerEnv(
      { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
      { PI_CODING_AGENT_DIR: join(root, "agent"), PAP_TEST_PROVIDER: "1" },
    ),
    clock: createSystemClock(),
    logger: silentLogger,
  });
  worker = handle;
  handle.send({
    type: "init",
    cwd: join(root, "work"),
    agentDir: join(root, "agent"),
    papHome: join(root, "pap"),
    umask: 0o022,
    policy,
    testProviderScript: join(root, "script.json"),
  });
  return handle;
}

function ready(handle: WorkerHandle): Promise<WorkerRecord> {
  return new Promise((resolve) => {
    const off = handle.onRecord((record) => {
      if (record.type === "ready") {
        off();
        resolve(record);
      }
    });
  });
}

async function boot(): Promise<WorkerHandle> {
  const handle = launch();
  await ready(handle);
  return handle;
}

describe("spawnWorker against the real worker", () => {
  it("runs the worker with the network guard loaded", () => {
    expect(EXEC_ARGV.slice(-2)).toEqual(["--import", NETWORK_GUARD]);
    expect(existsSync(NETWORK_GUARD)).toBe(true);
  });

  it("boots, answers get_state, and stops at the first rung of the kill ladder", async () => {
    const handle = await boot();
    const state = await handle.request({ type: "get_state" }, 5000);
    expect(state).toMatchObject({ success: true, data: { isStreaming: false } });
    expect(handle.stats()).toMatchObject({ droppedRecords: 0, unknownResponses: 0, pendingRequests: 0 });
    const started = Date.now();
    expect((await handle.stop()).cause).toBe("clean");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects pending requests and reports a kill when the worker dies", async () => {
    const handle = await boot();
    signalGroupOf(handle, "SIGKILL");
    await expect(handle.request({ type: "get_state" })).rejects.toThrow();
    expect((await handle.exited).cause).toBe("killed");
  });

  it("reports exit code 70 with the reason in the output tail when the init is refused", async () => {
    const handle = launch({ bogus: true });
    const exit = await handle.exited;
    expect(exit).toMatchObject({ code: 70, cause: "exit_code" });
    expect(describeExit(exit)).toBe("Agent process exited with code 70.");
    expect(handle.outputTail()).toContain("invalid policy rules");
  });

  it("stop is idempotent and resolves with the same exit every time", async () => {
    const handle = await boot();
    const [first, second] = await Promise.all([handle.stop(), handle.stop()]);
    expect(second).toBe(first);
    expect(await handle.stop()).toBe(first);
    expect(await handle.exited).toBe(first);
  });
});
