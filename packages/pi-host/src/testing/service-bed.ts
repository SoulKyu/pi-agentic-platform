import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import { afterAll, beforeAll } from "vitest";
import { fakeClock, layout } from "./guest-harness.ts";
import type { ProcReader } from "../guest/services/ownership.ts";
import { createServiceHost, type Launcher, type NsDialer } from "../guest/services/supervisor.ts";

type Listening = "own" | "stranger" | "none";

export class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  listening: Listening = "none";
  /** The signals that end it; a service that ignores SIGTERM has only SIGKILL. */
  dies: string[] = ["SIGTERM", "SIGKILL"];
  readonly pid: number;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(signal: string): boolean {
    if (this.dies.includes(signal)) queueMicrotask(() => this.end(null, signal));
    return true;
  }
  end(code: number | null, signal: string | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const stat = (pid: number, ppid: number): string =>
  `${pid} (x) S ${ppid} ${Array(17).fill("0").join(" ")} ${pid} 1`;
const listenRow = (port: number, inode: number): string =>
  `   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 0:0 00:0 0 1000 0 ${inode} 1`;

let server: net.Server;
/** The port of a real loopback server the supervisor's test connection reaches (set in `beforeAll`). */
export let port: number;
beforeAll(async () => {
  server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(() => void server.close());

export const start = (name: string, over: Record<string, unknown> = {}) =>
  ({ name: "svc.start", service: name, command: `serve ${name}`, port, network: true, ...over }) as never;
export const op = (name: string, service?: string) =>
  ({ name, ...(service === undefined ? {} : { service }) }) as never;

export function bed(
  over: {
    nsDialer?: (target: { pid: number; start: string }) => NsDialer | null;
    /** Wraps the fake `/proc` (a test makes a read throw). */
    wrapProc?: (proc: ProcReader) => ProcReader;
  } = {},
) {
  const { wrapProc, ...hostOver } = over;
  const clock = fakeClock();
  const children: FakeChild[] = [];
  const inputs: unknown[] = [];
  const signals: Array<[number, string]> = [];
  const reports: unknown[] = [];
  const logs: string[] = [];
  const launcher: Launcher = {
    netnsFrom: "child",
    start(input) {
      inputs.push(input);
      if (input.command === "boom") throw new Error("secret-detail ENOENT");
      const child = new FakeChild(100 + children.length * 10);
      children.push(child);
      return child as unknown as ChildProcess;
    },
    kill(child, signal) {
      signals.push([child.pid as number, signal]);
      child.kill(signal);
    },
  };
  const live = () => children.filter((child) => child.exitCode === null && child.signalCode === null);
  const proc: ProcReader = {
    pids: () => live().flatMap((child) => [child.pid, child.pid + 1]),
    stat: (pid) => {
      const owner = live().find((child) => child.pid === pid || child.pid + 1 === pid);
      return owner === undefined ? null : stat(pid, pid === owner.pid ? 1 : owner.pid);
    },
    fdLinks: (pid) =>
      live().some((child) => child.pid + 1 === pid && child.listening === "own") ? [`socket:[${pid}]`] : [],
    tcpTables: (pid) => {
      const owner = live().find((child) => child.pid + 1 === pid);
      if (owner === undefined || owner.listening === "none") return null;
      const inode = owner.listening === "own" ? pid : 9_000_000 + pid;
      return { v4: [HEADER, listenRow(port, inode)].join("\n"), v6: HEADER };
    },
  };
  const host = createServiceHost({
    layout,
    env: { PAP_GUEST_PROXY: "10.213.0.1:7843", PAP_GATEWAY: "10.213.0.1:7841" },
    clock,
    launcher,
    proc: wrapProc ? wrapProc(proc) : proc,
    report: (report) => void reports.push(report),
    log: (line) => void logs.push(line),
    ...hostOver,
  });
  const ticks = (count: number): void => {
    for (let n = 0; n < count; n++) clock.advance(250);
  };
  return { clock, children, inputs, signals, reports, logs, host, ticks };
}
