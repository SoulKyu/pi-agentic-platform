import { EventEmitter } from "node:events";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  AGENT_VM_PROTOCOL,
  type BoxRef,
  createFrameDecoder,
  encodeSocketFrame,
} from "@pap/contracts";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { createLogger } from "../../kernel/logger.ts";
import { createGatewayCore, type Gateway, type GatewaySocket } from "./gateway.ts";
import type { GuestLink } from "./guest-link.ts";
import { createLaunchTokens, type LaunchTokens } from "./tokens.ts";
import type { MirrorPort, PackagePicks, WorkerSpawnInput } from "./vm-worker.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";

export const AGENT: BoxRef = { kind: "agent", id: "reviewer-0a1b" };
export const OTHER_AGENT: BoxRef = { kind: "agent", id: "writer-2c3d" };
export const PROJECT: BoxRef = { kind: "project", id: "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11" };

/** The gateway's end of a connection, with the guest's end driven by the test. */
export class FakeSocket extends EventEmitter implements GatewaySocket {
  readonly written: Buffer[] = [];
  destroyed = false;
  pauses = 0;
  resumes = 0;
  writableLength = 0;
  readonly remoteAddress: string | undefined;
  constructor(remoteAddress: string | undefined = "10.213.0.2") {
    super();
    this.remoteAddress = remoteAddress;
  }
  write(chunk: Buffer): boolean {
    this.written.push(chunk);
    return true;
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
  pause(): this {
    this.pauses++;
    return this;
  }
  resume(): this {
    this.resumes++;
    return this;
  }
  /** The peer sends one frame. */
  feed(value: unknown): void {
    this.emit("data", encodeSocketFrame(value));
  }
  feedRaw(chunk: Buffer): void {
    this.emit("data", chunk);
  }
  /** The peer closes its end. */
  hangUp(): void {
    this.emit("close");
  }
  /** Every frame the gateway wrote, decoded. */
  frames(): unknown[] {
    const out: unknown[] = [];
    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (value) => void out.push(value),
      onError: () => {},
    });
    for (const chunk of this.written) decoder.push(chunk);
    return out;
  }
}

export interface Launch {
  readonly box: BoxRef;
  readonly launchId: string;
  readonly token: string;
  readonly relayKey: string;
  readonly imageTag: string;
}

export const imageTagOf = (digit: string): string => `pap-agent-agent-${digit.repeat(64)}`;

export interface Harness {
  readonly clock: FakeClock;
  readonly tokens: LaunchTokens;
  readonly gateway: Gateway & { accept(socket: GatewaySocket): void };
  readonly images: Map<string, string>;
  readonly lines: Array<Record<string, unknown>>;
  launch(box?: BoxRef, digit?: string): Launch;
  connect(source?: string): FakeSocket;
  refusals(): Array<{ box: unknown; reason: unknown }>;
}

export function harness(): Harness {
  const clock = createFakeClock();
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const tokens = createLaunchTokens();
  const images = new Map<string, string>();
  const gateway = createGatewayCore({ tokens, clock, logger, imageOf: (id) => images.get(id) ?? null });
  return {
    clock,
    tokens,
    gateway,
    images,
    lines,
    launch(box = AGENT, digit = "a") {
      const issued = tokens.issue(box);
      const imageTag = imageTagOf(digit);
      images.set(issued.launchId, imageTag);
      return { box, ...issued, imageTag };
    },
    connect(source) {
      const socket = new FakeSocket(source);
      gateway.accept(socket);
      return socket;
    },
    refusals: () =>
      lines
        .filter((line) => line.msg === "agent_gateway_refused")
        .map((line) => ({ box: line.box, reason: line.reason })),
  };
}

export const guestHello = (launch: Launch, overrides: Record<string, unknown> = {}) => ({
  type: "hello",
  role: "guest",
  box: launch.box,
  launchId: launch.launchId,
  token: launch.token,
  protocol: AGENT_VM_PROTOCOL,
  imageTag: launch.imageTag,
  ...overrides,
});

export const workerHello = (launch: Launch, slot: string, overrides: Record<string, unknown> = {}) => ({
  ...guestHello(launch),
  role: "worker",
  slot,
  session: { file: null, lastEntryId: null, size: 0 },
  ...overrides,
});

export const mirrorStub = (path = "/mirrors/s.jsonl"): MirrorPort => ({
  path,
  facts: () => ({ size: 0, lastEntryId: null }),
  onSessionAppend: () => "ok",
  close: () => {},
});

export const spawnInput = (overrides: Partial<WorkerSpawnInput> = {}): WorkerSpawnInput => ({
  sessionFile: null,
  sessionsDir: "/agent/.pi/sessions",
  mirrorFor: () => mirrorStub(),
  unsent: () => false,
  sent: () => {},
  ...overrides,
});

export async function guestOf(h: Harness, launch: Launch): Promise<{ socket: FakeSocket; link: GuestLink }> {
  const socket = h.connect();
  socket.feed(guestHello(launch));
  return { socket, link: await h.gateway.awaitGuest(launch.launchId) };
}

/** Asks the guest for a worker and answers as that worker; resolves with the handle once its hello is in. */
export async function workerOf(
  h: Harness,
  launch: Launch,
  guest: { socket: FakeSocket; link: GuestLink },
  options: { input?: WorkerSpawnInput; packages?: PackagePicks; session?: Record<string, unknown> } = {},
): Promise<{ handle: WorkerHandle; socket: FakeSocket; slot: string }> {
  const spawning = guest.link.spawnWorker(options.input ?? spawnInput(), options.packages ?? null);
  const spawn = guest.socket.frames().at(-1) as { type: string; slot: string };
  const socket = h.connect();
  socket.feed(workerHello(launch, spawn.slot, options.session ? { session: options.session } : {}));
  return { handle: await spawning, socket, slot: spawn.slot };
}
