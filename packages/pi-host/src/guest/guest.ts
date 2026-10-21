import type { ChildProcess } from "node:child_process";
import type net from "node:net";
import type { Writable } from "node:stream";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  createFrameDecoder,
  encodeSocketFrame,
  GUEST_BOOT_TIMEOUT_MS,
  GuestCommand,
  GuestHello,
  AGENT_VM_PROTOCOL,
  type GuestReport,
  type VmLayout,
} from "@pap/contracts";
import { errorClass, logLineOf } from "../bounded.ts";
import { proxyEnv } from "../vm-shell/proxy-env.ts";
import { allowedExtraEnv } from "./extra-env.ts";

/** Mirrors the daemon's kill-ladder grace (AVM-P6): pi-host cannot import the daemon. */
export const GUEST_SHUTDOWN_GRACE_MS = 1500;
const DIAL_RETRY_MS = 1000;
const DIAL_ATTEMPT_MS = 5000;
/** How long an exited worker's pipes get to drain before its report goes out anyway. */
const PIPE_DRAIN_MS = 250;
const TAIL_BYTES = 8192;
/** The host part of `PAP_GATEWAY` (`host:port`): the proxy never carries the gateway's own traffic. */
const gatewayHostOf = (address: string | undefined): string | undefined =>
  address === undefined ? undefined : address.slice(0, address.lastIndexOf(":"));
const PONG = encodeSocketFrame({ type: "pong" });

export interface GuestClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(ms: number): Promise<void>;
}

export interface GuestDeps {
  /** The guest's own environment (already scrubbed of the token): the gateway variables and the agent's identity. */
  env: NodeJS.ProcessEnv;
  token: string;
  layout: VmLayout;
  connect(address: string): net.Socket;
  spawn(slot: string, env: NodeJS.ProcessEnv): ChildProcess;
  clock: GuestClock;
  seed(): void;
  pick(packages: string[] | null): void;
  grow(): Promise<void>;
  /** Ends the guest; Kata stops the VM when its entrypoint exits. */
  exit(code: number): void;
  /** Signals a worker's whole process group. */
  signalGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void;
  log(line: string): void;
}

interface Worker {
  child: ChildProcess;
  tail: Buffer;
}

/**
 * The VM's supervisor (R4, R24, R28). Grows the file system, seeds Pi's folder, dials the gateway as `guest` and runs
 * workers on the daemon's command, handing each the token on fd 3 (never in an environment). A closed gateway kills every
 * worker and exits 1 (RT-47). Resolves after `exit` was called. Nothing here logs the token or a rejected command's content.
 */
export async function runGuest(deps: GuestDeps): Promise<void> {
  const { clock, layout, log } = deps;
  const workers = new Map<string, Worker>();
  const spawned = new Set<string>();
  let socket: net.Socket | undefined;
  let shuttingDown = false;
  let over = false;
  let graceTimer: unknown;
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const end = (code: number): void => {
    if (over) return;
    over = true;
    if (graceTimer !== undefined) clock.clearTimeout(graceTimer);
    socket?.end();
    deps.exit(code);
    finish();
  };
  const send = (report: GuestReport): void => {
    if (socket && !socket.destroyed && !over) socket.write(encodeSocketFrame(report));
  };
  const killAll = (signal: "SIGTERM" | "SIGKILL"): void => {
    for (const { child } of workers.values()) deps.signalGroup(child, signal);
  };
  const failSlot = (slot: string, why: string): void =>
    send({ type: "exited", slot, code: 1, signal: null, tail: `pap-guest: ${why}` });

  const hello = GuestHello.safeParse({
    type: "hello",
    role: "guest",
    agentId: deps.env.PAP_AGENT_ID,
    launchId: deps.env.PAP_LAUNCH_ID,
    token: deps.token,
    protocol: AGENT_VM_PROTOCOL,
    imageTag: deps.env.PAP_IMAGE_TAG,
  });
  if (!hello.success || !deps.env.PAP_GATEWAY) {
    const fields = hello.success ? ["PAP_GATEWAY"] : hello.error.issues.map((issue) => issue.path.join("."));
    log(`the guest hello is invalid (fields: ${[...new Set(fields)].join(", ")})`);
    end(1);
    return ended;
  }

  try {
    await deps.grow();
  } catch (error) {
    log(`the file system could not grow: ${logLineOf(error)}`);
  }
  try {
    deps.seed();
  } catch (error) {
    log(`the agent folder could not be seeded: ${logLineOf(error)}`);
    end(1);
    return ended;
  }

  const attempt = (): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const candidate = deps.connect(deps.env.PAP_GATEWAY as string);
      const timer = clock.setTimeout(
        () => candidate.destroy(new Error("connect timed out")),
        DIAL_ATTEMPT_MS,
      );
      candidate.once("connect", () => {
        clock.clearTimeout(timer);
        candidate.off("error", fail);
        resolve(candidate);
      });
      const fail = (error: Error): void => {
        clock.clearTimeout(timer);
        candidate.destroy();
        reject(error);
      };
      candidate.once("error", fail);
    });
  // The bridge port's set element may lag the VM's boot: frames are dropped until it exists (RT-35).
  const startedAt = clock.now();
  for (;;) {
    try {
      socket = await attempt();
      break;
    } catch {
      if (clock.now() - startedAt >= GUEST_BOOT_TIMEOUT_MS) {
        log("the gateway could not be reached before the boot deadline");
        end(1);
        return ended;
      }
      await clock.sleep(DIAL_RETRY_MS);
    }
  }

  const link = socket;
  link.setNoDelay(true);
  link.write(encodeSocketFrame(hello.data));

  const startWorker = (command: Extract<GuestCommand, { type: "spawn" }>): void => {
    const { slot } = command;
    if (workers.has(slot)) return log(`ignored a spawn of slot ${slot}: it is already running`);
    if (spawned.has(slot))
      return log(`ignored a spawn of slot ${slot}: it already ran (never spawned twice)`);
    spawned.add(slot);
    try {
      deps.pick(command.packages);
    } catch (error) {
      log(`the packages of slot ${slot} could not be set: ${logLineOf(error)}`);
      return failSlot(slot, "the packages could not be set");
    }
    const env: NodeJS.ProcessEnv = {
      ...deps.env,
      PAP_WORKER_TRANSPORT: "socket",
      PAP_WORKER_SLOT: slot,
      PI_CODING_AGENT_DIR: layout.piAgentDir,
      GIT_CEILING_DIRECTORIES: layout.root,
    };
    Reflect.deleteProperty(env, "PAP_GATEWAY_TOKEN");
    Reflect.deleteProperty(env, "PAP_GUEST_PROXY");
    Object.assign(env, allowedExtraEnv(command.env, layout.home, log));
    // Spec §3: everything that runs in the VM reaches the network only through pap's egress proxy.
    const proxy = deps.env.PAP_GUEST_PROXY;
    if (proxy) Object.assign(env, proxyEnv(`http://${proxy}`, gatewayHostOf(deps.env.PAP_GATEWAY)));
    if (command.sessionFile === null) Reflect.deleteProperty(env, "PAP_SESSION_FILE");
    else env.PAP_SESSION_FILE = command.sessionFile;
    let child: ChildProcess;
    try {
      child = deps.spawn(slot, env);
    } catch (error) {
      log(`slot ${slot} could not start: ${errorClass(error)}`);
      return failSlot(slot, "the worker could not start");
    }
    const worker: Worker = { child, tail: Buffer.alloc(0) };
    workers.set(slot, worker);
    const collect = (chunk: Buffer | string): void => {
      worker.tail = Buffer.concat([worker.tail, Buffer.from(chunk)]).subarray(-TAIL_BYTES);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const pipe = child.stdio[3] as Writable | null | undefined;
    if (!pipe) {
      log(`slot ${slot} has no token pipe`);
      deps.signalGroup(child, "SIGKILL");
    } else {
      pipe.on("error", (error) => log(`the token pipe of slot ${slot} failed: ${errorClass(error)}`));
      pipe.end(deps.token);
    }

    let result: { code: number | null; signal: string | null } | undefined;
    let drain: unknown;
    const report = (): void => {
      if (!workers.delete(slot)) return;
      if (drain !== undefined) clock.clearTimeout(drain);
      send({
        type: "exited",
        slot,
        ...(result ?? { code: null, signal: null }),
        tail: worker.tail.toString("utf8"),
      });
      if (shuttingDown && workers.size === 0) end(0);
    };
    child.once("exit", (code, signal) => {
      result = { code, signal };
      drain = clock.setTimeout(report, PIPE_DRAIN_MS);
    });
    child.once("close", (code, signal) => {
      result ??= { code, signal };
      report();
    });
    child.on("error", (error) => {
      log(`slot ${slot} failed: ${errorClass(error)}`);
      result ??= { code: 1, signal: null };
      if (child.pid === undefined) report();
    });
    send({ type: "spawned", slot });
  };

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (workers.size === 0) return end(0);
    killAll("SIGTERM");
    graceTimer = clock.setTimeout(() => {
      killAll("SIGKILL");
      end(0);
    }, GUEST_SHUTDOWN_GRACE_MS);
  };

  const handle = (raw: unknown): void => {
    // A transport ping is answered before the command schema sees it (AVM-P4).
    if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "ping") {
      if (!link.destroyed) link.write(PONG);
      return;
    }
    const parsed = GuestCommand.safeParse(raw);
    if (!parsed.success) {
      const type = (raw as { type?: unknown } | null)?.type;
      log(
        `dropped an unknown command (type: ${typeof type === "string" ? logLineOf(type).slice(0, 32) : typeof raw})`,
      );
      return;
    }
    const command = parsed.data;
    if (shuttingDown && command.type !== "shutdown") return;
    if (command.type === "spawn") return startWorker(command);
    if (command.type === "shutdown") return shutdown();
    const worker = workers.get(command.slot);
    if (!worker) return log(`ignored a signal for slot ${command.slot}: no such worker`);
    deps.signalGroup(worker.child, command.signal);
  };

  const decoder = createFrameDecoder({
    maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
    onFrame: handle,
    onError: (error) => {
      log(`gateway frame refused (${error})`);
      link.destroy();
    },
  });
  link.on("data", (chunk) => decoder.push(chunk));
  link.on("error", (error) => log(`gateway socket error: ${errorClass(error)}`));
  link.on("close", () => {
    decoder.stop();
    if (over) return;
    // The daemon is gone or dropped us: stopping every worker and the VM is how a daemon stop reaches the agent (RT-47).
    log("the gateway connection closed: stopping");
    killAll("SIGKILL");
    end(1);
  });
  return ended;
}
