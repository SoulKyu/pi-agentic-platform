import { type BoxRef, boxKey, DEFAULT_AGENT_RESOURCES, PapError } from "@pap/contracts";
import { vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { classifyExit, type WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { Gateway } from "./gateway.ts";
import type { GuestLink } from "./guest-link.ts";
import { layoutOfSpec } from "./layouts.ts";
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeBackend,
  type AgentRuntimeDeps,
  type LaunchGrant,
  type VmSpec,
} from "./runtime.ts";
import { createLaunchTokens, type LaunchTokens } from "./tokens.ts";
import type { VmWorkerHandle, WorkerSpawnInput } from "./vm-worker.ts";

export const IDLE_MS = 30 * 60_000;
export const CAP_MB = 4096;
export const IMAGE = `pap-agent-agent-${"a".repeat(64)}`;

export const agentBox = (id: string): BoxRef => ({ kind: "agent", id });
export const PROJECT_ID = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
export const specOf = (agentId: string, extra: Partial<VmSpec> = {}): VmSpec => ({
  box: { kind: "agent", id: agentId },
  kind: "thread",
  taskKey: null,
  image: IMAGE,
  resources: { ...DEFAULT_AGENT_RESOURCES, memoryMb: 1024 },
  ...extra,
});

export const workerInput = (): WorkerSpawnInput => ({
  sessionFile: null,
  sessionsDir: "/ignored",
  mirrorFor: () => "refused",
  unsent: () => false,
  sent: () => {},
});

export interface FakeGuest {
  readonly link: GuestLink;
  readonly handles: Array<VmWorkerHandle & { end(exit?: WorkerExit): void }>;
  readonly spawned: WorkerSpawnInput[];
  crash(): void;
  shutdown: ReturnType<typeof vi.fn>;
}

export function fakeGuest(order: string[]): FakeGuest {
  let crash: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    crash = resolve;
  });
  const handles: FakeGuest["handles"] = [];
  const spawned: WorkerSpawnInput[] = [];
  const shutdown = vi.fn();
  const link: GuestLink = {
    spawnWorker(input) {
      order.push("spawnWorker");
      spawned.push(input);
      let end: (exit: WorkerExit) => void = () => {};
      const exited = new Promise<WorkerExit>((resolve) => {
        end = resolve;
      });
      const handle = {
        pid: undefined,
        exited,
        slot: `slot-${handles.length}`,
        stop: vi.fn(() => {
          end(classifyExit(null, "SIGTERM"));
          return exited;
        }),
        end: (exit: WorkerExit = classifyExit(0, null)) => end(exit),
      } as unknown as FakeGuest["handles"][number];
      handles.push(handle);
      return Promise.resolve(handle);
    },
    shutdown,
    openTerminal: () => Promise.reject(new Error("unused")),
    sendOp: () => false,
    onOpResult: () => () => undefined,
    closed,
  };
  return { link, handles, spawned, crash, shutdown };
}

export interface Bed {
  clock: FakeClock;
  tokens: LaunchTokens;
  order: string[];
  guests: Map<string, FakeGuest>;
  starts: Array<{ spec: VmSpec; launch: { launchId: string; token: string } }>;
  grants: LaunchGrant[];
  ended: string[];
  crashPauses: string[];
  capacity: string[][];
  listed: Array<{ box: BoxRef; taskKey: string | null }>;
  failStart: { error: Error | null };
  backend: AgentRuntimeBackend & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  gateway: Gateway & { awaitGuest: ReturnType<typeof vi.fn> };
  runtime: AgentRuntime;
  /** The i-th started launch (negative: from the end), its guest and its grant. */
  launchAt(index: number): { launchId: string; token: string };
  guestAt(index: number): FakeGuest;
  grantAt(index: number): LaunchGrant;
}

export function bed(extra: Partial<AgentRuntimeDeps> = {}): Bed {
  const clock = createFakeClock();
  const tokens = createLaunchTokens();
  const order: string[] = [];
  const guests = new Map<string, FakeGuest>();
  const starts: Bed["starts"] = [];
  const failStart = { error: null as Error | null };
  const listed: Bed["listed"] = [];
  const backend = {
    start: vi.fn((spec: VmSpec, launch: { launchId: string; token: string }) => {
      order.push("start");
      starts.push({ spec, launch });
      if (failStart.error) return Promise.reject(failStart.error);
      guests.set(launch.launchId, fakeGuest(order));
      return Promise.resolve({ address: "10.213.0.9" });
    }),
    stop: vi.fn((box: BoxRef, taskKey: string | null) => {
      order.push(`stop:${box.id}:${taskKey ?? ""}`);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve(listed)),
  };
  const gateway = {
    listen: vi.fn(),
    close: vi.fn(),
    awaitGuest: vi.fn((launchId: string) => {
      order.push("awaitGuest");
      const guest = guests.get(launchId);
      return guest ? Promise.resolve(guest.link) : Promise.reject(new PapError("timeout"));
    }),
  };
  const result = {
    clock,
    tokens,
    order,
    guests,
    starts,
    grants: [] as LaunchGrant[],
    ended: [] as string[],
    crashPauses: [] as string[],
    capacity: [] as string[][],
    listed,
    failStart,
    backend,
    gateway,
  } as unknown as Bed;
  const must = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`no ${what}`);
    return value;
  };
  result.launchAt = (index) => must(starts.at(index), "start").launch;
  result.guestAt = (index) => must(guests.get(result.launchAt(index).launchId), "guest");
  result.grantAt = (index) => must(result.grants.at(index), "grant");
  result.runtime = createAgentRuntime({
    backend,
    gateway,
    tokens,
    clock,
    logger: silentLogger,
    memoryCapMb: CAP_MB,
    idleMs: IDLE_MS,
    layout: (spec) => layoutOfSpec("process", "/pap", spec),
    onLaunch: (grant) => {
      order.push("onLaunch");
      result.grants.push(grant);
    },
    onLaunchEnd: (launchId) => void result.ended.push(launchId),
    onCrashPause: (box) => void result.crashPauses.push(boxKey(box)),
    notifyCapacity: (running) => void result.capacity.push(running),
    ...extra,
  });
  return result;
}

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
