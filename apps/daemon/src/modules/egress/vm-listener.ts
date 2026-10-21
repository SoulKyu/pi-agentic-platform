import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { EGRESS_LIMITS } from "@pap/contracts";
import type { TimerHandle } from "../../kernel/clock.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import { type Limits, createCores, type ProxyCore, sendAndClose } from "./proxy-core.ts";
import { BAD_HEAD } from "./refusal.ts";
import { loggedHosts, writtenEntries } from "./report.ts";
import { createVmJudge, type VmJudgeDeps, type VmRefusal, type VmScope } from "./vm-judge.ts";

export type { VmRefusal, VmScope } from "./vm-judge.ts";

export interface VmEgressDeps extends Pick<
  VmJudgeDeps,
  "clock" | "logger" | "resolve" | "addressRefused" | "hostAddresses"
> {
  connect(ip: string, port: number): Socket;
  /** The launch behind a source address, with its host list now (the agent's, else the owner's); null: no running launch. */
  scopeOf(address: string): VmScope | null;
  onRefusal(refusal: VmRefusal): void;
}

/** A VM's tunnels live as long as the VM: the per-command byte cap of host mode would cut a long transfer. */
const VM_LIMITS: Limits = { ...EGRESS_LIMITS, bytes: Number.POSITIVE_INFINITY };
const USAGE_EVERY_MS = 60_000;
const UNKNOWN_BODY = "pap egress proxy: this address is not a running agent VM, nothing was sent.\n";
const UNKNOWN_SOURCE = `HTTP/1.1 403 Forbidden\r\nx-pap-deny: unknown_source\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(UNKNOWN_BODY)}\r\n\r\n${UNKNOWN_BODY}`;

interface Live {
  readonly launchId: string;
  readonly address: string;
  readonly core: ProxyCore;
  scope: VmScope;
}

/** `::ffff:10.213.0.5` (a dual-stack socket) is the address 10.213.0.5. */
const peerOf = (socket: Socket): string | null => socket.remoteAddress?.replace(/^::ffff:/i, "") ?? null;

/**
 * pap's egress proxy for the agents' VMs (spec §3): one TCP listener on the bridge. The VM is told by its source address
 * alone (pap-vmd pins each VM's bridge port to it); the request is judged against that launch's host list and the VM address
 * policy, and an address with no running launch is refused. Per agent, requests, refusals and bytes are logged every minute.
 */
export function createVmEgress(deps: VmEgressDeps) {
  const { clock, logger } = deps;
  const cores = createCores({
    clock,
    logger,
    connect: (ip, port) => deps.connect(ip, port),
    limits: VM_LIMITS,
  });
  const judge = createVmJudge({
    clock,
    logger,
    resolve: (host) => deps.resolve(host),
    resolveMs: VM_LIMITS.resolveMs,
    addressRefused: deps.addressRefused,
    hostAddresses: () => deps.hostAddresses(),
  });
  const live = new Map<string, Live>();
  const owners = new WeakMap<Socket, Live>();
  let server: Server | null = null;
  let timer: TimerHandle | null = null;

  const report = (entry: Live): void => {
    const taken = entry.core.rotate();
    const requests = taken.allowed + taken.refused;
    if (requests === 0 && taken.report.up === 0 && taken.report.down === 0) return;
    logger.info("egress_vm_usage", {
      agentId: entry.scope.agentId,
      launchId: entry.launchId,
      requests,
      refused: taken.refused,
      up: taken.report.up,
      down: taken.report.down,
      hosts: loggedHosts(
        taken.report,
        { hosts: [...writtenEntries(entry.scope.hosts)], trustedSources: [], grants: () => [] },
        VM_LIMITS.logHosts,
      ),
    });
  };
  const retire = (entry: Live): void => {
    report(entry);
    entry.core.close();
    if (live.get(entry.address) === entry) live.delete(entry.address);
  };
  const tick = (): void => {
    timer = clock.setTimeout(() => void guardTimer(logger, "egress_vm_usage", tick, clock), USAGE_EVERY_MS);
    for (const entry of [...live.values()]) {
      const now = deps.scopeOf(entry.address);
      if (now === null || now.launchId !== entry.launchId) retire(entry);
      else report(entry);
    }
  };

  /** The core of the launch behind `address`; a new launch on a reused address replaces the old one's. */
  function liveFor(address: string, scope: VmScope): Live {
    const known = live.get(address);
    if (known?.launchId === scope.launchId) return known;
    if (known) retire(known);
    const lane = {}; // names this VM to the lookup semaphore
    const entry: Live = {
      launchId: scope.launchId,
      address,
      scope,
      core: cores.create({
        scope: { agentId: scope.agentId, sessionId: scope.launchId },
        async decide(kind, rawHost, port) {
          // The host list is read at each request, so an add takes effect at the next one.
          const now = deps.scopeOf(address);
          if (now === null || now.launchId !== scope.launchId)
            return {
              reason: "not_listed",
              host: "an unknown source",
              message: "pap egress proxy: this VM has no running launch on record, so nothing is allowed.",
            };
          entry.scope = now;
          const decision = await judge.decide(now, lane, kind, rawHost, port);
          if ("reason" in decision && decision.vm) {
            try {
              deps.onRefusal({
                agentId: now.agentId,
                launchId: now.launchId,
                source: now.source,
                host: decision.host,
                port,
                reason: decision.vm.reason,
                address: decision.vm.address,
              });
            } catch (error) {
              logger.warn("egress_vm_refusal_sink_failed", { err: error });
            }
          }
          return decision;
        },
      }),
    };
    live.set(address, entry);
    return entry;
  }

  function build(): Server {
    const created = createServer({
      maxHeaderSize: VM_LIMITS.headBytes,
      headersTimeout: 0,
      requestTimeout: 0,
    });
    created.on("connection", (socket) => {
      socket.on("error", () => {});
      const address = peerOf(socket);
      let scope: VmScope | null = null;
      try {
        scope = address === null ? null : deps.scopeOf(address);
      } catch (error) {
        // A failing database read must answer and log, never reach the process: the source stays unknown.
        logger.warn("egress_vm_scope_failed", { err: error });
      }
      if (address === null || scope === null) {
        sendAndClose(socket, UNKNOWN_SOURCE);
        return;
      }
      const entry = liveFor(address, scope);
      owners.set(socket, entry);
      entry.core.accept(socket);
    });
    created.on("clientError", (error: NodeJS.ErrnoException, socket) => {
      const entry = owners.get(socket as Socket);
      if (entry) entry.core.clientError(error, socket);
      else sendAndClose(socket, BAD_HEAD);
    });
    created.on("request", (req, res) => {
      const entry = owners.get(req.socket);
      if (entry) entry.core.request(req, res);
      else req.socket.destroy();
    });
    created.on("connect", (req, socket: Socket, head: Buffer) => {
      const entry = owners.get(socket);
      if (entry) entry.core.connect(req, socket, head);
      else socket.destroy();
    });
    return created;
  }

  return {
    /** Listens on `host:port` (port 0: any); answers the port. */
    async listen(host: string, port: number): Promise<number> {
      const created = build();
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(port, host, () => {
          created.off("error", reject);
          resolve();
        });
      });
      server = created;
      timer = clock.setTimeout(() => void guardTimer(logger, "egress_vm_usage", tick, clock), USAGE_EVERY_MS);
      const bound = created.address();
      return typeof bound === "object" && bound !== null ? bound.port : port;
    },
    async close(): Promise<void> {
      if (timer) clock.clearTimeout(timer);
      timer = null;
      for (const entry of [...live.values()]) retire(entry);
      const closing = server;
      server = null;
      if (closing === null) return;
      closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    },
  };
}
