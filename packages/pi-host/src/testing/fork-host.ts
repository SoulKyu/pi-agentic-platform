import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PI_HOST_MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
export const NETWORK_GUARD = fileURLToPath(new URL("./network-guard.ts", import.meta.url));
// The daemon's own worker flags (`workerExecArgv` in apps/daemon/src/kernel/config.ts), so that memory readings
// taken on a bed match production.
export const DEV_EXEC_ARGV = [
  "--conditions=development",
  "--max-semi-space-size=16",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];

export type HostRecord = { type: string } & Record<string, unknown>;

export interface ForkedHost {
  readonly child: ChildProcess;
  readonly records: HostRecord[];
  readonly exited: Promise<number | null>;
  /** Resolves when the worker's output is complete: after the exit, once stdout and stderr have closed. */
  readonly closed: Promise<void>;
  readonly stderr: () => string;
  send(record: object): void;
  request(record: HostRecord): Promise<HostRecord>;
  waitFor(
    predicate: (record: HostRecord) => boolean,
    options?: { from?: number; timeoutMs?: number },
  ): Promise<HostRecord>;
  kill(): void;
}

export function forkHost(env: NodeJS.ProcessEnv, cwd: string): ForkedHost {
  const child = fork(PI_HOST_MAIN, [], {
    cwd,
    env,
    execArgv: DEV_EXEC_ARGV,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  child.stdout?.resume();
  const records: HostRecord[] = [];
  const wakers = new Set<() => void>();
  child.on("message", (record: HostRecord) => {
    records.push(record);
    for (const wake of [...wakers]) wake();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => {
      for (const wake of [...wakers]) wake();
      resolve(code);
    }),
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const waitFor = (predicate: (record: HostRecord) => boolean, { from = 0, timeoutMs = 20_000 } = {}) =>
    new Promise<HostRecord>((resolve, reject) => {
      const check = () => {
        const hit = records.slice(from).find(predicate);
        if (hit) {
          done();
          resolve(hit);
        } else if (child.exitCode !== null || child.signalCode !== null) {
          done();
          reject(new Error(`pi-host exited: ${stderr.join("")}`));
        }
      };
      const deadline = setTimeout(() => {
        done();
        reject(new Error(`timed out waiting for a record; stderr: ${stderr.join("")}`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(deadline);
        wakers.delete(check);
      };
      wakers.add(check);
      check();
    });
  let nextId = 0;
  return {
    child,
    records,
    exited,
    closed,
    stderr: () => stderr.join(""),
    send: (record) => child.send(record),
    request: (record) => {
      const id = `t${++nextId}`;
      child.send({ ...record, id });
      return waitFor((r) => r.type === "response" && r.id === id);
    },
    waitFor,
    kill: () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}
