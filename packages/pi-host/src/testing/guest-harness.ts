import { EventEmitter } from "node:events";
import net from "node:net";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, vi } from "vitest";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  createFrameDecoder,
  encodeSocketFrame,
  type VmLayout,
} from "@pap/contracts";
import { runGuest, type GuestClock, type GuestDeps } from "../guest/guest.ts";

export const TOKEN = "ab".repeat(32);
export const SLOT = "1".repeat(32);
export const SLOT_B = "2".repeat(32);
export const IDENTITY = {
  PAP_AGENT_ID: "scout-ab12",
  PAP_LAUNCH_ID: "a".repeat(32),
  PAP_IMAGE_TAG: `pap-agent-agent-${"c".repeat(64)}`,
  PAP_GATEWAY: "127.0.0.1:1",
};
export const layout: VmLayout = {
  root: "/agent",
  home: "/agent/home",
  knowledge: "/agent/knowledge",
  inbox: "/agent/inbox",
  pi: "/agent/.pi",
  sessions: "/agent/.pi/sessions",
  piAgentDir: "/agent/.pi/agent",
  imageAgentDir: "/opt/pap/pi-agent",
  shellOverlay: "/run/pap-shell",
};

export function fakeClock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  let sleepers = 0;
  const clock: GuestClock & { advance(ms: number): void; pending(): number; sleeping(): number } = {
    now: () => now,
    setTimeout(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimeout(handle) {
      timers = timers.filter((timer) => timer !== handle);
    },
    sleep: (ms) => {
      sleepers += 1;
      return new Promise((resolve) =>
        clock.setTimeout(() => {
          sleepers -= 1;
          resolve();
        }, ms),
      );
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.fn();
    },
    pending: () => timers.length,
    sleeping: () => sleepers,
  };
  return clock;
}

export interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdio: unknown[];
  token: string;
  tokenEnded: boolean;
  exit(code: number | null, signal?: string | null): void;
}
export function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.token = "";
  child.tokenEnded = false;
  const fd3 = new Writable({
    write(chunk: Buffer, _encoding, done) {
      child.token += chunk.toString();
      done();
    },
  });
  fd3.on("finish", () => {
    child.tokenEnded = true;
  });
  child.stdio = [null, child.stdout, child.stderr, fd3];
  child.exit = (code, signal = null) => {
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  return child;
}

const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
});

export async function daemon() {
  const server = net.createServer();
  const frames: unknown[] = [];
  let peer: net.Socket | undefined;
  server.on("connection", (socket) => {
    peer = socket;
    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (value) => frames.push(value),
      onError: () => undefined,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stoppers.push(() => {
    peer?.destroy();
    server.close();
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    frames,
    send: (value: unknown) => void peer?.write(encodeSocketFrame(value)),
    sendRaw: (bytes: Buffer) => void peer?.write(bytes),
    hangUp: () => void peer?.destroy(),
  };
}

export async function start(over: Partial<GuestDeps> = {}) {
  const gateway = await daemon();
  const clock = fakeClock();
  const exits: number[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  const children: FakeChild[] = [];
  const spawnEnvs: NodeJS.ProcessEnv[] = [];
  const killed: Array<[number, string]> = [];
  const picks: unknown[] = [];
  const deps: GuestDeps = {
    env: { ...IDENTITY },
    token: TOKEN,
    layout,
    connect: () => net.connect(gateway.port, "127.0.0.1"),
    spawn: (_slot, env) => {
      order.push("spawn");
      const child = fakeChild(1000 + children.length);
      children.push(child);
      spawnEnvs.push(env);
      return child as unknown as ChildProcess;
    },
    clock,
    seed: () => void order.push("seed"),
    pick: (packages) => {
      order.push("pick");
      picks.push(packages);
    },
    grow: () => {
      order.push("grow");
      return Promise.resolve();
    },
    exit: (code) => void exits.push(code),
    signalGroup: (child, signal) => void killed.push([child.pid as number, signal]),
    log: (line) => void logs.push(line),
    ...over,
  };
  const done = runGuest(deps);
  const hello = async () => vi.waitFor(() => expect(gateway.frames.length).toBeGreaterThan(0));
  return { gateway, clock, exits, logs, order, children, spawnEnvs, killed, picks, done, hello };
}

export const spawnCommand = (extra: Record<string, unknown> = {}) => ({
  type: "spawn",
  slot: SLOT,
  sessionFile: "/agent/.pi/sessions/s.jsonl",
  packages: null,
  ...extra,
});
