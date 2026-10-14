import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import type { NodePty } from "../../kernel/pty/load.ts";
import { loadNodePty } from "../../kernel/pty/load.ts";
import { NO_SCOPES } from "../../kernel/supervisor/scope.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createStreamHub } from "../../kernel/ws/stream-hub.ts";
import { testCaller } from "../../testing/caller.ts";
import { createTerminalModule } from "./index.ts";
import { createFakeConnection } from "./testing/fake-stream.ts";

let base: string;
let project: string;
let module: ReturnType<typeof createTerminalModule>;
/** What the module did to the real PTY's flow, in order. */
let flow: string[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pap-term-real-")));
  project = join(base, "project");
  for (const dir of [project, join(base, "home"), join(base, "agent"), join(base, "user")]) mkdirSync(dir);
  flow = [];
  const real = loadNodePty(silentLogger) as NodePty;
  // The real node-pty, with its `pause` and `resume` recorded.
  const watched = {
    ...real,
    spawn: (...args: Parameters<NodePty["spawn"]>) => {
      const child = real.spawn(...args);
      const { pause, resume } = child;
      child.pause = () => {
        flow.push("pause");
        pause.call(child);
      };
      child.resume = () => {
        flow.push("resume");
        resume.call(child);
      };
      return child;
    },
  } as NodePty;
  module = createTerminalModule({
    roots: () => [project],
    boundary: {
      papHome: [join(base, "home")],
      agentDir: [join(base, "agent")],
      home: [join(base, "user")],
      papHomeOpen: [],
      runtimeDirs: [],
    },
    hub: createStreamHub("epoch"),
    clock: createSystemClock(),
    logger: silentLogger,
    env: { PATH: process.env.PATH, HOME: join(base, "user"), SHELL: "/bin/sh", LANG: "C.UTF-8" },
    scopes: NO_SCOPES,
    workerUmask: 0o022,
    maxTerminals: 4,
    minFreeMemMb: 0,
    loadPty: () => watched,
  });
});

afterEach(async () => {
  await module.shutdown();
  rmSync(base, { recursive: true, force: true });
});

const open = async () => {
  const connection = createFakeConnection();
  const ctx = {
    caller: testCaller(),
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
    binary: connection,
  };
  const { terminalId } = await module.rpc["terminal.create"](
    { requestId: "q".repeat(16), cwd: project, cols: 80, rows: 24 },
    ctx,
  );
  await module.rpc["terminal.attach"]({ terminalId }, ctx);
  const stream = connection.last();
  stream.commit();
  return { terminalId, stream, ctx };
};

const pidOf = (name: string): number | null => {
  try {
    return Number(readFileSync(join(project, name), "utf8").trim()) || null;
  } catch {
    return null;
  }
};

describe("a real shell behind a paused PTY (MC27, M8R58)", () => {
  it("delivers every byte the shell printed before it died, then the exit frame", async () => {
    execFileSync("mkfifo", [join(project, "gate")]);
    const { stream } = await open();
    // The socket takes nothing: the first output pauses the PTY, and nobody acks.
    stream.accepting = false;
    const payload = "z".repeat(200);
    stream.input(1, `read _ < gate; printf 'BEGIN-%s-END' ${payload}; exit 7\r`);
    await vi.waitFor(() => expect(flow).toEqual(["pause"]), { timeout: 15_000, interval: 10 });

    // The shell prints and dies while the PTY is paused: node-pty gives the socket 200 ms before it drops it.
    await writeFile(join(project, "gate"), "go\n");
    await vi.waitFor(() => expect(flow).toEqual(["pause", "resume"]), { timeout: 15_000, interval: 10 });
    stream.accepting = true;
    await vi.waitFor(() => expect(stream.frames.some((frame) => frame.op === "exit")).toBe(true), {
      timeout: 15_000,
      interval: 10,
    });

    expect(stream.frames.at(-1)?.op).toBe("exit");
    expect(stream.frames.filter((frame) => frame.op === "exit")).toHaveLength(1);
    expect(stream.text()).toContain(`BEGIN-${payload}-END`);
    expect(JSON.parse(new TextDecoder().decode(stream.frames.at(-1)?.payload))).toEqual({
      code: 7,
      signal: null,
    });
  });
});

describe("close with the default kill ladder", () => {
  it("ends a shell that ignores SIGHUP and the job it left running", async () => {
    const { terminalId, stream } = await open();
    stream.input(1, 'trap "" HUP; echo $$ > shell.pid; sleep 1000 & echo $! > job.pid; sleep 1001\r');
    await vi.waitFor(() => expect([pidOf("shell.pid"), pidOf("job.pid")]).not.toContain(null), {
      timeout: 15_000,
      interval: 10,
    });
    const pids = [pidOf("shell.pid"), pidOf("job.pid")] as number[];
    await module.rpc["terminal.close"](
      { terminalId },
      {
        caller: testCaller(),
        connectionId: "c1",
        openSubscription: () => "s1",
        closeSubscription: () => {},
      },
    );
    await vi.waitFor(() => expect(pids.filter((pid) => existsSync(`/proc/${pid}`))).toEqual([]), {
      timeout: 5000,
      interval: 20,
    });
    expect(stream.closes).toBe(1);
  });
});
