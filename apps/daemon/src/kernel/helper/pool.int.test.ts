import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Clock, createSystemClock } from "../clock.ts";
import { type LogFields, type Logger, silentLogger } from "../logger.ts";
import { createHelperPool, type HelperHandle, type HelperPool, STDIO_DRAIN_MS } from "./pool.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/helper/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];

/**
 * A run with this deadline never times out by itself: the clock holds its timer until the test fires it. A real
 * 800 ms deadline raced the helper's start under load (the helper must report its child first), which made the
 * test fail once in a clean-env run; the kill ladder and everything else still run on the real clock.
 */
const HELD_DEADLINE_MS = 424_242;
/**
 * The pool's output wait (`STDIO_DRAIN_MS`) for a dead helper's output is dropped too: the helper's pipes closing (`close`) ends the run
 * as soon as the daemon has read everything, however long that takes under load; with the real wait a slow reader
 * could cut the tail the flood test asserts. (The flake seen in the flood test itself was the helper's test op losing
 * its last write at `process.exit`; that is fixed in `ops/testing.ts`.)
 */
const HELD_HANDLE = { id: -1 };
const DROPPED_HANDLE = { id: -2 };
function heldDeadlineClock(): { clock: Clock; fireDeadline(): void } {
  const system = createSystemClock();
  let held: (() => void) | undefined;
  return {
    clock: {
      ...system,
      setTimeout: (fn, ms) => {
        if (ms === STDIO_DRAIN_MS) return DROPPED_HANDLE;
        if (ms !== HELD_DEADLINE_MS) return system.setTimeout(fn, ms);
        held = fn;
        return HELD_HANDLE;
      },
      clearTimeout: (handle) => {
        if (handle === HELD_HANDLE) held = undefined;
        else if (handle !== DROPPED_HANDLE) system.clearTimeout(handle);
      },
    },
    fireDeadline() {
      const fn = held;
      held = undefined;
      if (!fn) throw new Error("no held deadline: the run already ended");
      fn();
    },
  };
}

let root: string;
let pool: HelperPool;
let deadlines: ReturnType<typeof heldDeadlineClock>;
let logs: Array<{ msg: string; fields: LogFields | undefined }>;
const logger: Logger = { ...silentLogger, warn: (msg, fields) => void logs.push({ msg, fields }) };

const makePool = (max = 4): HelperPool =>
  createHelperPool({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    baseEnv: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      HOME: join(root, "home"),
      PI_OFFLINE: "1",
      PAP_HOME: "/must/not/leak",
      PAP_SESSION_SECRET: "must-not-leak",
      NODE_OPTIONS: "--max-old-space-size=256",
    },
    agentDir: join(root, "agent"),
    papHome: join(root, "pap"),
    extraEnv: { PAP_TEST_PROVIDER: "1" },
    tailOps: new Set(["test.print"]),
    max,
    clock: deadlines.clock,
    logger,
  });

beforeEach(() => {
  deadlines = heldDeadlineClock();
  root = mkdtempSync(join(tmpdir(), "pap-helper-"));
  for (const dir of ["agent", "pap", "home"]) mkdirSync(join(root, dir));
  logs = [];
  pool = makePool();
});
afterEach(async () => {
  try {
    await pool.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // A connection the guard refused may have been swallowed by the code that tried it: the log still says so.
  expect(JSON.stringify(logs)).not.toContain("pap-network-guard: blocked");
});

const alive = (pid: number): boolean => {
  expect(pid).toBeGreaterThan(1);
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed child nobody has reaped yet is a zombie: dead, but still signalable.
  try {
    return !/^\d+ \(.*\) Z/s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

/** Runs `test.hang` and resolves with the pid of the child it started in its group. */
function hang(deadlineMs: number): Promise<{ handle: HelperHandle; childPid: number }> {
  return new Promise((resolve, reject) => {
    const handle = pool.run(
      "test.hang",
      {},
      {
        deadlineMs,
        onEvent: (event) => resolve({ handle, childPid: (event as { childPid: number }).childPid }),
      },
    );
    // The deadline fired before the helper reported its child: the test cannot say anything, so it fails loudly.
    handle.done.catch(reject);
  });
}

describe("a real helper", () => {
  it("answers ping with the version of the Pi SDK it loaded", async () => {
    const result = await pool.run("ping", {}, { deadlineMs: 30_000 }).done;
    expect(result).toEqual({ piVersion: VERSION });
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it("runs with the worker's environment rules, in tmpdir, under the network guard", async () => {
    const result = (await pool.run("test.env", {}, { deadlineMs: 30_000 }).done) as {
      env: Record<string, string>;
      cwd: string;
      execArgv: string[];
    };
    expect(Object.keys(result.env).filter((key) => key.startsWith("PAP_"))).toEqual(["PAP_TEST_PROVIDER"]);
    expect(result.env.NODE_OPTIONS).toBeUndefined();
    expect(result.env.PI_TELEMETRY).toBe("0");
    expect(result.env.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(result.env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
    expect(result.env.HOME).toBe(join(root, "home"));
    expect(realpathSync(result.cwd)).toBe(realpathSync(tmpdir()));
    expect(result.execArgv).toContain(NETWORK_GUARD);
  });

  it("answers unknown_op to a test op when the daemon was not started for tests", async () => {
    const production = createHelperPool({
      entry: ENTRY,
      execArgv: EXEC_ARGV,
      baseEnv: { PATH: process.env.PATH, HOME: join(root, "home") },
      agentDir: join(root, "agent"),
      papHome: join(root, "pap"),
      max: 1,
      clock: createSystemClock(),
      logger,
    });
    await expect(production.run("test.env", {}, { deadlineMs: 30_000 }).done).rejects.toMatchObject({
      code: "internal",
    });
  });

  it("maps a throwing op to helper_failed and keeps its text out of the error", async () => {
    const failure = await pool
      .run("test.throw", {}, { deadlineMs: 30_000 })
      .done.catch((error: PapError) => error);
    expect(failure).toBeInstanceOf(PapError);
    expect(failure).toMatchObject({ code: "helper_failed", message: "The Pi configuration helper failed." });
    expect(logs.find((entry) => entry.msg === "helper_op_failed")?.fields).toMatchObject({
      detail: "Error: deliberate failure",
    });
  });

  it("rejects bad params as bad_request", async () => {
    await expect(pool.run("ping", { extra: 1 }, { deadlineMs: 30_000 }).done).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("kills a helper at its deadline and leaves no process in its group", async () => {
    const { handle, childPid } = await hang(HELD_DEADLINE_MS);
    expect(alive(childPid)).toBe(true);
    deadlines.fireDeadline();
    await expect(handle.done).rejects.toMatchObject({ code: "timeout" });
    await expect.poll(() => alive(childPid), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => pool.active(), { timeout: 15_000 }).toBe(0);
  });

  it("keeps a tail of what a flooding helper prints, and completes", async () => {
    const result = await pool.run("test.print", { megabytes: 100 }, { deadlineMs: 120_000 }).done;
    expect(result).toEqual({ printed: 100 });
  });

  it("logs only the end of the output of a helper that flooded and then died", async () => {
    const failure = await pool
      .run("test.print", { megabytes: 5, exitAfter: true }, { deadlineMs: 120_000 })
      .done.catch((e: PapError) => e);
    expect(failure).toMatchObject({ code: "helper_failed" });
    const fields = logs.find((entry) => entry.msg === "helper_failed")?.fields as { tail: string };
    expect(fields.tail.length).toBe(2048);
    expect(fields.tail.endsWith("END-OF-OUTPUT")).toBe(true);
  });

  it("round-trips the answer to a prompt", async () => {
    const handle = pool.run(
      "test.prompt",
      { prompt: "Sign in?" },
      {
        deadlineMs: 30_000,
        onPrompt: (promptId, prompt) => {
          expect(prompt).toEqual({ text: "Sign in?" });
          expect(handle.answer(promptId, "yes")).toBe(true);
        },
      },
    );
    expect(await handle.done).toEqual({ answer: "yes" });
  });

  it("kills a helper that floods events, prompts or garbage", async () => {
    await expect(pool.run("test.events", { count: 300 }, { deadlineMs: 30_000 }).done).rejects.toMatchObject({
      code: "helper_failed",
    });
    await expect(pool.run("test.prompts", { count: 20 }, { deadlineMs: 30_000 }).done).rejects.toMatchObject({
      code: "helper_failed",
    });
    for (const kind of ["oversized", "garbage", "unknown_type"] as const)
      await expect(pool.run("test.rogue", { kind }, { deadlineMs: 30_000 }).done).rejects.toMatchObject({
        code: "helper_failed",
      });
    expect(logs.map((entry) => (entry.fields as { why?: string } | undefined)?.why).filter(Boolean)).toEqual([
      "too_many_events",
      "too_many_prompts",
      "oversized",
      "malformed",
      "malformed",
    ]);
  });

  it("refuses a run beyond the cap at once, with real helpers running", async () => {
    pool = makePool(2);
    const first = await hang(60_000);
    const second = await hang(60_000);
    expect(pool.active()).toBe(2);
    expect(() => pool.run("ping", {}, { deadlineMs: 1000 })).toThrow(
      expect.objectContaining({ code: "capacity" }),
    );
    first.handle.cancel();
    second.handle.cancel();
  });

  it("stopAll kills a running helper and its group", async () => {
    const { handle, childPid } = await hang(60_000);
    await pool.stopAll();
    await expect(handle.done).rejects.toMatchObject({ code: "helper_failed" });
    // The group gets its SIGKILL when the helper exits, but the child dies when the kernel next schedules it.
    await expect.poll(() => alive(childPid), { timeout: 15_000 }).toBe(false);
    expect(pool.active()).toBe(0);
  });
});

describe("the daemon dies", () => {
  it("makes the helper exit when its channel closes, taking its group with it", async () => {
    const child = fork(ENTRY, [], {
      cwd: tmpdir(),
      execArgv: EXEC_ARGV,
      env: { PATH: process.env.PATH, HOME: join(root, "home"), PAP_TEST_PROVIDER: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    try {
      const childPid = await new Promise<number>((resolve) => {
        child.on("message", (record: { type?: string; event?: { childPid: number } }) => {
          if (record.type === "helper_event" && record.event) resolve(record.event.childPid);
        });
        child.send({
          type: "helper_run",
          op: "test.hang",
          agentDir: join(root, "agent"),
          papHome: join(root, "pap"),
          params: {},
        });
      });
      const exited = new Promise<"exited">((resolve) => child.once("exit", () => resolve("exited")));
      child.disconnect();
      // The helper ends at once on `disconnect` (ADR 0023). The bound only tells "ended" from "waits forever": it is
      // generous because a loaded host can take seconds to schedule the exit, and the `finally` below ends the group.
      const outcome = await Promise.race([
        exited,
        createSystemClock()
          .sleep(20_000)
          .then(() => "still running"),
      ]);
      expect(outcome).toBe("exited");
      await expect.poll(() => alive(childPid), { timeout: 5000 }).toBe(false);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
