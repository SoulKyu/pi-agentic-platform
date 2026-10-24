import { VmdRequest, type BoxRef } from "@pap/contracts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocks, type Locks } from "../locks.ts";
import type { Logger } from "../log.ts";
import { createOps, type ExecResult, type NetPort, type Ops } from "../ops.ts";
import { createState, type VmdState } from "../state.ts";
import { createFakeClock, type FakeClock } from "./fake-clock.ts";
import { createFakeExec, type ExecHandler, type FakeExec } from "./fake-exec.ts";
import { createFakeNet, type FakeNet } from "./fake-net.ts";

export const AGENT = "helper-1a2b";
export const OTHER_AGENT = "writer-3c4d";
export const PROJECT_ID = "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";
export const AGENT_BOX: BoxRef = { kind: "agent", id: AGENT };
export const OTHER_BOX: BoxRef = { kind: "agent", id: OTHER_AGENT };
export const PROJECT: BoxRef = { kind: "project", id: PROJECT_ID };
export const TASK = "e".repeat(32);
export const TOKEN = "c".repeat(64);
export const LAUNCH = "a".repeat(32);
export const IMAGE = `pap-agent-agent-${"b".repeat(64)}`;
export const MIB = 1024 * 1024;

/** The ops as the server calls them, but a request is parsed first (as the server does), so a test cannot send an invalid one. */
export interface FixtureOps {
  handle(request: unknown): Promise<unknown>;
  runningTasks: Ops["runningTasks"];
  /** Waits for the background reclaim jobs. */
  idle(): Promise<void>;
}

export interface Fixture {
  readonly work: string;
  readonly papHome: string;
  readonly bundle: string;
  readonly volumeRoot: string;
  /** Where CNI's host-local keeps one file per reserved address (a temp folder). */
  readonly ipamRoot: string;
  readonly state: VmdState;
  readonly ops: FixtureOps;
  readonly exec: FakeExec;
  readonly net: FakeNet;
  /** One ordered log of `prepare`, `attach`, `run <name>` and `rm <name>`, from the fake net and the fake exec. */
  readonly order: string[];
  readonly clock: FakeClock;
  readonly logs: { event: string; fields: Record<string, unknown> }[];
  /** What `nerdctl ps` prints, one `<name> <status>` line each. */
  ps: string[];
  psCode: number;
  /** The room check: set it to reject. */
  room: (needMb: number) => Promise<void>;
  roomAsked: number[];
  cleanup(): void;
}

export function startRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: "vm.start",
    box: AGENT_BOX,
    kind: "thread",
    taskKey: null,
    image: IMAGE,
    resources: { memoryMb: 1024, cpus: 1, diskMb: 4096 },
    launchId: LAUNCH,
    token: TOKEN,
    ...extra,
  };
}

function healthyHost(argv: readonly string[]): Partial<ExecResult> | undefined {
  if (argv[0] === "/usr/sbin/nft") return { stdout: "table bridge pap_agents {}\n" };
  if (argv[0] === "/usr/sbin/ip" && argv.includes("link"))
    return { stdout: "7: pap0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n" };
  return undefined;
}

export function createFixture(
  handler: ExecHandler = () => undefined,
  options: {
    locks?: Locks;
    net?: NetPort;
    unleased?: readonly string[];
    sweepNetns?: () => number;
    holdsFile?: (file: string) => boolean;
  } = {},
): Fixture {
  const work = mkdtempSync(path.join(tmpdir(), "pap-vmd-ops-"));
  const clock = createFakeClock();
  const logs: Fixture["logs"] = [];
  const log: Logger = { info: (event, fields) => void logs.push({ event, fields }) };
  const state = createState({ root: path.join(work, "state"), clock, log });
  state.ensure();
  const papHome = path.join(work, "pap-home");
  const bundle = path.join(work, "bundle");
  const volumeRoot = path.join(work, "vol");
  const ipamRoot = path.join(work, "ipam");
  mkdirSync(ipamRoot);
  mkdirSync(papHome);
  mkdirSync(bundle);
  const order: string[] = [];
  const net = createFakeNet(order);
  const fixture: Fixture = {
    work,
    papHome,
    bundle,
    volumeRoot,
    ipamRoot,
    state,
    net,
    order,
    clock,
    logs,
    ps: [],
    psCode: 0,
    room: () => Promise.resolve(),
    roomAsked: [],
    cleanup: () => rmSync(work, { recursive: true, force: true }),
    // Assigned below, once `exec` can read the fixture.
    ops: undefined as unknown as FixtureOps,
    exec: undefined as unknown as FakeExec,
  };
  const exec = createFakeExec((argv) => {
    if (argv.at(-1) === "{{.Names}} {{.Status}}")
      return { code: fixture.psCode, stdout: fixture.ps.map((line) => `${line}\n`).join("") };
    if (argv.includes("run")) order.push("run");
    if (argv.includes("rm")) order.push(`rm ${argv.at(-1) ?? ""}`);
    // The ruleset and the bridge are there unless a test says otherwise (vm.start checks both, AVM-E49).
    return Promise.resolve(handler(argv)).then((answer) => answer ?? healthyHost(argv));
  });
  const uid = process.getuid?.() ?? 0;
  const ops = createOps({
    exec: exec.exec,
    net: options.net ?? net,
    state,
    locks: options.locks ?? createLocks(),
    room: (needMb) => {
      fixture.roomAsked.push(needMb);
      return fixture.room(needMb);
    },
    clock,
    log,
    papUid: uid,
    papHome,
    bundleRoot: bundle,
    bundleUid: uid,
    volumeRoot,
    ipamRoot,
    version: "1.2.3",
    unleased: options.unleased ?? [],
    ...(options.sweepNetns ? { sweepNetns: options.sweepNetns } : {}),
    ...(options.holdsFile ? { holdsFile: options.holdsFile } : {}),
  });
  Object.assign(fixture, {
    exec,
    ops: {
      handle: (request: unknown) => ops.handle(VmdRequest.parse(request)),
      runningTasks: ops.runningTasks,
      idle: ops.idle,
    },
  });
  return fixture;
}

/** A box's disk as a file with some bytes (pap-vmd never reads it). */
export function seedDisk(fx: Fixture, box: BoxRef = AGENT_BOX, bytes = "agent disk"): string {
  const file = fx.state.diskPath(box, null);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}
