import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import {
  SERVICE_LIMITS,
  type BoxOp,
  type GuestReport,
  type ServiceView,
  type VmLayout,
} from "@pap/contracts/pi-host";
import { errorClass } from "../../bounded.ts";
import { proxyEnv } from "../../vm-shell/proxy-env.ts";
import type { GuestClock } from "../guest.ts";
import type { OpAnswer } from "../ops/index.ts";
import type { ServiceLaunchInput } from "./launch.ts";
import { createLogRing, type LogRing } from "./log-ring.ts";
import { checkOwnership, type NetnsFrom, type Ownership, type ProcReader } from "./ownership.ts";

/** How a service is started and signalled; `bwrapLauncher` in a VM, `plainLauncher` for the process backend. */
export interface Launcher {
  readonly netnsFrom: NetnsFrom;
  start(input: ServiceLaunchInput): ChildProcess;
  /** Signals the process `start` returned: the outer bwrap (never a pid of the tree), or the plain launch's own group. */
  kill(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void;
}

/**
 * A way into the network namespace of a service without network, held by a descriptor (T6, UX2-R59, R62): `close` releases
 * it. `connect` dials `host:port` inside that namespace.
 */
export interface NsDialer {
  connect(host: string, port: number): Promise<net.Socket>;
  close(): void;
}

export type ServiceOp = Extract<BoxOp, { name: `svc.${string}` }>;
export const isServiceOp = (op: BoxOp): op is ServiceOp => op.name.startsWith("svc.");

export interface ServiceHost {
  /** Answers `svc.*` (the guest calls it before its project or agent ops). */
  op(op: ServiceOp): Promise<OpAnswer>;
  /** A connected socket to a running service's port, ownership checked again (spec §5); throws a fixed-sentence Error otherwise. */
  connectTo(serviceId: string): Promise<net.Socket>;
  /** The guest is ending: every service is stopped (SIGKILL at once). */
  closeAll(): void;
}

export interface ServiceHostDeps {
  readonly layout: VmLayout;
  readonly env: NodeJS.ProcessEnv;
  readonly clock: GuestClock;
  readonly launcher: Launcher;
  readonly proc: ProcReader;
  report(report: Extract<GuestReport, { type: "service" }>): void;
  log(line: string): void;
  /**
   * The namespace helper of a service without network (T6 provides it in `main.ts`); absent for the plain launcher. Null when
   * the namespace cannot be held (`openNetns`, UX2-R62): the pid changed under the check, and the next readiness check runs again.
   * Its `connect` must settle within 2 s (`CONNECT_MS`): the supervisor stops waiting then, closes the dialer and destroys a
   * socket that arrives late.
   */
  nsDialer?(target: { pid: number; start: string }): NsDialer | null;
}

const READY_POLL_MS = 250;
const CONNECT_MS = 2_000;

interface Spec {
  readonly name: string;
  readonly command: string;
  readonly port: number;
  readonly network: boolean;
}

interface Rec {
  readonly id: string;
  readonly spec: Spec;
  readonly startedAt: number;
  readonly ring: LogRing;
  state: "starting" | ServiceView["state"];
  reason: ServiceView["reason"];
  child: ChildProcess | null;
  /** The child's `exit` came (or it never started): nothing is signalled any more. */
  ended: boolean;
  /** An exit from here on is the guest's doing (a stop, a failure, the end), not the service's. */
  stopping: boolean;
  /** SIGKILL was sent: once is enough, however many times the guest asks. */
  killed: boolean;
  tick: unknown;
  grace: unknown;
  waiters: Array<() => void>;
  settle: ((view: ServiceView) => void) | null;
}

const live = (rec: Rec): boolean => rec.state === "starting" || rec.state === "running";
const ok = (value: unknown): OpAnswer => ({ ok: true, value });

/**
 * The guest's preview services (UX-2 §5): at most 4 per box, each a command in the session shell's sandbox, `running` only
 * while the port it was asked to serve is listened on by its own process tree. Everything a service prints stays in its ring;
 * no answer carries it. Timers go through the guest clock.
 */
export function createServiceHost(deps: ServiceHostDeps): ServiceHost {
  const { clock, launcher, proc, layout, log } = deps;
  const records = new Map<string, Rec>();
  /** The guest is ending: nothing starts any more (a start waiting on a stop would otherwise spawn after `closeAll`). */
  let closed = false;
  const proxyUrl = deps.env.PAP_GUEST_PROXY;
  const gatewayHost = deps.env.PAP_GATEWAY?.slice(0, deps.env.PAP_GATEWAY.lastIndexOf(":"));
  const proxy = proxyUrl ? proxyEnv(`http://${proxyUrl}`, gatewayHost) : {};

  const view = (rec: Rec): ServiceView => ({
    id: rec.id,
    name: rec.spec.name,
    port: rec.spec.port,
    state: rec.state === "starting" ? "stopped" : rec.state,
    reason: rec.reason,
    startedAt: rec.startedAt,
    network: rec.spec.network,
  });

  const finish = (rec: Rec): void => {
    const settle = rec.settle;
    rec.settle = null;
    settle?.(view(rec));
  };

  /** Every signal first looks at what Node knows of the child: after its `exit` nothing is sent (the pid may be reused). */
  const signal = (rec: Rec, how: "SIGTERM" | "SIGKILL"): void => {
    const child = rec.child;
    if (rec.ended || child === null || child.exitCode !== null || child.signalCode !== null) return;
    if (how === "SIGKILL") {
      if (rec.killed) return;
      rec.killed = true;
    }
    try {
      launcher.kill(child, how);
    } catch (error) {
      log(`service ${rec.spec.name}: ${how} failed (${errorClass(error)})`);
    }
  };

  const clearTimers = (rec: Rec): void => {
    if (rec.tick !== undefined) clock.clearTimeout(rec.tick);
    if (rec.grace !== undefined) clock.clearTimeout(rec.grace);
    rec.tick = rec.grace = undefined;
  };

  /** SIGTERM to the outer process, SIGKILL after the grace; resolves when it has exited. */
  function stopChild(rec: Rec): Promise<void> {
    rec.stopping = true;
    if (rec.ended) return Promise.resolve();
    const done = new Promise<void>((resolve) => rec.waiters.push(resolve));
    if (rec.grace === undefined) {
      signal(rec, "SIGTERM");
      rec.grace = clock.setTimeout(() => signal(rec, "SIGKILL"), SERVICE_LIMITS.stopGraceMs);
    }
    return done;
  }

  function onEnd(rec: Rec, code: number | null, how: string | null, spawnFailed = false): void {
    if (rec.ended) return;
    rec.ended = true;
    clearTimers(rec);
    if (!rec.stopping && rec.state === "starting") {
      rec.state = "failed";
      rec.reason = spawnFailed ? "spawn_failed" : "exited";
    } else if (!rec.stopping && rec.state === "running") {
      rec.state = "exited";
      deps.report({ type: "service", id: rec.id, state: "exited", code, signal: how });
    }
    for (const resolve of rec.waiters.splice(0)) resolve();
    finish(rec);
  }

  const fail = (rec: Rec, reason: NonNullable<ServiceView["reason"]>): void => {
    rec.state = "failed";
    rec.reason = reason;
    void stopChild(rec);
  };

  function dial(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = clock.setTimeout(() => socket.destroy(new Error("connect timed out")), CONNECT_MS);
      const refuse = (error: Error): void => {
        clock.clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once("connect", () => {
        clock.clearTimeout(timer);
        socket.off("error", refuse);
        resolve(socket);
      });
      socket.once("error", refuse);
    });
  }

  /** The helper's `connect` is bounded like a direct one; a socket that arrives after the bound is destroyed. */
  function within(pending: Promise<net.Socket>): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      let late = false;
      const timer = clock.setTimeout(() => {
        late = true;
        reject(new Error("connect timed out"));
      }, CONNECT_MS);
      pending.then(
        (socket) => {
          clock.clearTimeout(timer);
          if (late) socket.destroy();
          else resolve(socket);
        },
        (error: unknown) => {
          clock.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** A connection to the service: direct when it shares the guest's namespace, through the helper otherwise; null without one. */
  async function reach(rec: Rec, own: Extract<Ownership, { owned: true }>): Promise<net.Socket | null> {
    const { port, network } = rec.spec;
    if (network || launcher.netnsFrom === "root") return dial(own.host, port);
    const dialer = deps.nsDialer?.({ pid: own.nsPid, start: own.nsStart }) ?? null;
    if (dialer === null) return null;
    try {
      const socket = await within(dialer.connect(own.host, port));
      socket.once("close", () => dialer.close());
      return socket;
    } catch (error) {
      dialer.close();
      throw error;
    }
  }

  async function probe(rec: Rec, own: Extract<Ownership, { owned: true }>): Promise<boolean> {
    try {
      const socket = await reach(rec, own);
      socket?.destroy();
      return socket !== null;
    } catch {
      // not connectable yet: the next check tries again, and the 30 s deadline reports it as port_timeout
      return false;
    }
  }

  async function check(rec: Rec): Promise<void> {
    rec.tick = undefined;
    const pid = rec.child?.pid;
    if (rec.ended || rec.stopping || rec.state !== "starting" || pid === undefined) return;
    const own = checkOwnership(pid, rec.spec.port, launcher.netnsFrom, proc);
    if (own.owned) {
      const connected = await probe(rec, own);
      if (rec.ended || rec.stopping || rec.state !== "starting") return;
      if (connected) {
        rec.state = "running";
        return finish(rec);
      }
    } else if (own.reason === "port_not_owned") return fail(rec, "port_not_owned");
    if (clock.now() - rec.startedAt >= SERVICE_LIMITS.readyMs) return fail(rec, "port_timeout");
    rec.tick = clock.setTimeout(() => runCheck(rec), READY_POLL_MS);
  }

  /** A check that throws (a `/proc` read, the helper) fails the service instead of leaving its start unanswered. */
  function runCheck(rec: Rec): void {
    check(rec).catch((error: unknown) => {
      log(`service ${rec.spec.name} check failed: ${errorClass(error)}`);
      fail(rec, "port_timeout");
    });
  }

  async function start(spec: Spec): Promise<OpAnswer> {
    // A running name is stopped first (a start on it is a restart); a concurrent start of the same name is stopped too.
    for (let old = records.get(spec.name); old !== undefined && live(old); old = records.get(spec.name)) {
      old.state = "stopped";
      await stopChild(old);
    }
    if (closed) return { ok: false, code: "failed" };
    let running = 0;
    for (const rec of records.values()) if (live(rec)) running++;
    if (running >= SERVICE_LIMITS.perBox) return { ok: false, code: "conflict" };
    if (!records.has(spec.name) && records.size >= SERVICE_LIMITS.perBox) {
      let oldest: Rec | undefined;
      for (const rec of records.values())
        if (!live(rec) && (oldest === undefined || rec.startedAt < oldest.startedAt)) oldest = rec;
      if (oldest !== undefined) records.delete(oldest.spec.name);
    }
    const rec: Rec = {
      id: randomBytes(16).toString("hex"),
      spec,
      startedAt: clock.now(),
      ring: createLogRing(),
      state: "starting",
      reason: null,
      child: null,
      ended: false,
      stopping: false,
      killed: false,
      tick: undefined,
      grace: undefined,
      waiters: [],
      settle: null,
    };
    records.set(spec.name, rec);
    let child: ChildProcess;
    try {
      child = launcher.start({
        layout,
        network: spec.network,
        command: spec.command,
        port: spec.port,
        proxy,
      });
    } catch (error) {
      log(`service ${spec.name} could not start: ${errorClass(error)}`);
      rec.state = "failed";
      rec.reason = "spawn_failed";
      rec.ended = true;
      return ok(view(rec));
    }
    rec.child = child;
    child.stdout?.on("data", (chunk: Buffer) => rec.ring.write(chunk, 1));
    child.stderr?.on("data", (chunk: Buffer) => rec.ring.write(chunk, 2));
    child.once("exit", (code, how) => onEnd(rec, code, how));
    // The output is complete once the pipes close, which can be after `exit`.
    child.once("close", () => rec.ring.flush());
    child.on("error", (error) => {
      log(`service ${spec.name} failed: ${errorClass(error)}`);
      // a process that never started has no pid and no `exit`
      if (child.pid === undefined) onEnd(rec, null, null, true);
    });
    return new Promise<OpAnswer>((resolve) => {
      rec.settle = (settled) => resolve(ok(settled));
      rec.tick = clock.setTimeout(() => runCheck(rec), READY_POLL_MS);
    });
  }

  return {
    async op(request) {
      switch (request.name) {
        case "svc.start":
          return start({
            name: request.service,
            command: request.command,
            port: request.port,
            network: request.network,
          });
        case "svc.restart": {
          const stored = records.get(request.service);
          return stored === undefined ? { ok: false, code: "not_found" } : start(stored.spec);
        }
        case "svc.stop": {
          const rec = records.get(request.service);
          if (rec === undefined || !live(rec)) return ok({ stopped: false });
          rec.state = "stopped";
          await stopChild(rec);
          return ok({ stopped: true });
        }
        case "svc.list":
          return ok({ services: [...records.values()].filter((rec) => rec.state !== "starting").map(view) });
        case "svc.logs": {
          const rec = records.get(request.service);
          return rec === undefined ? { ok: false, code: "not_found" } : ok({ lines: rec.ring.lines() });
        }
      }
    },

    async connectTo(serviceId) {
      const rec = [...records.values()].find((candidate) => candidate.id === serviceId);
      const pid = rec?.child?.pid;
      if (rec === undefined || rec.state !== "running" || rec.ended || pid === undefined)
        throw new Error("service is not running");
      const own = checkOwnership(pid, rec.spec.port, launcher.netnsFrom, proc);
      if (!own.owned)
        throw new Error(
          own.reason === "port_not_owned"
            ? "service port is not owned by the service"
            : "service is not reachable",
        );
      const socket = await reach(rec, own).catch(() => null);
      if (socket === null) throw new Error("service is not reachable");
      return socket;
    },

    closeAll() {
      closed = true;
      for (const rec of records.values()) {
        if (live(rec)) rec.state = "stopped";
        rec.stopping = true;
        clearTimers(rec);
        signal(rec, "SIGKILL");
      }
    },
  };
}
