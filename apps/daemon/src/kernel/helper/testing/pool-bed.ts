import { EventEmitter } from "node:events";
import { afterEach, beforeEach, type MockInstance, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../clock.ts";
import { type LogFields, type Logger, silentLogger } from "../../logger.ts";
import { killAllWorkerGroups } from "../../supervisor/process-group.ts";
import { createHelperPool, type HelperPool } from "../pool.ts";

/** What a test file's `vi.mock("node:child_process")` factory reads: the children `fork` hands out, in order. */
export interface ForkState {
  children: unknown[];
  forkArgs: unknown[][];
}

let nextPid = 5000;
export class FakeChild extends EventEmitter {
  pid = nextPid++;
  connected = true;
  stdout: EventEmitter & { destroy: () => void } = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  stderr: EventEmitter & { destroy: () => void } = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  sent: Array<{ type: string } & Record<string, unknown>> = [];
  send = vi.fn(
    (record: { type: string } & Record<string, unknown>, callback?: (error: Error | null) => void) => {
      this.sent.push(record);
      callback?.(null);
      return true;
    },
  );
  deliver(record: unknown): void {
    this.emit("message", record);
  }
  end(code = 0): void {
    this.emit("exit", code, null);
    this.emit("close");
  }
}

export const BASE_ENV = {
  PATH: "/bin",
  PAP_HOME: "/secret/home",
  PAP_TOKEN: "t",
  NODE_OPTIONS: "--require x",
  HOME: "/h",
};

export interface StartOptions {
  deadlineMs?: number;
  onEvent?: (e: unknown) => void;
  onPrompt?: (id: string, p: unknown) => void;
}

/** A pool over fake children, a fake clock and a spied `process.kill`, reset around each test. */
export function useHelperBed(state: ForkState) {
  const bed = {
    clock: undefined as unknown as FakeClock,
    pool: undefined as unknown as HelperPool,
    kill: undefined as unknown as MockInstance<typeof process.kill>,
    logs: [] as Array<{ level: string; msg: string; fields: LogFields | undefined }>,
    makePool(max = 4): HelperPool {
      const logger: Logger = {
        ...silentLogger,
        warn: (msg, fields) => void bed.logs.push({ level: "warn", msg, fields }),
        error: (msg, fields) => void bed.logs.push({ level: "error", msg, fields }),
      };
      return createHelperPool({
        entry: "/helper/main.ts",
        execArgv: ["--conditions=development"],
        baseEnv: BASE_ENV,
        agentDir: "/agent",
        papHome: "/pap",
        extraEnv: {},
        max,
        clock: bed.clock,
        logger,
      });
    },
    start(options: StartOptions = {}) {
      const child = new FakeChild();
      state.children.push(child);
      const handle = bed.pool.run("ping", { a: 1 }, { deadlineMs: options.deadlineMs ?? 60_000, ...options });
      // Rejections are asserted by the tests that care; this one keeps the others from leaking an unhandled one.
      handle.done.catch(() => {});
      return { child, handle };
    },
    signals: () => bed.kill.mock.calls.map(([pid, signal]) => `${pid}:${String(signal)}`),
  };
  beforeEach(() => {
    bed.clock = createFakeClock();
    bed.logs = [];
    state.children.length = 0;
    state.forkArgs.length = 0;
    bed.kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    bed.pool = bed.makePool();
  });
  afterEach(() => {
    killAllWorkerGroups();
    bed.kill.mockRestore();
  });
  return bed;
}

export const ofType = (child: FakeChild, type: string) => child.sent.filter((record) => record.type === type);
