import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import type { AgentsVmDerived } from "./compose-agents-vm-late.ts";
import { createLaunchAddresses, createLaunchTaint, type LaunchGrant } from "./modules/agent-vm/index.ts";
import {
  createVmEgress,
  type VmEgressDeps,
  hostAddressesNow,
  hostLabel,
  type VmRefusal,
  vmAddressRefused,
  writtenEntries,
} from "./modules/egress/index.ts";

/** Tests only: the proxy's network seams (loopback origins, an address policy that accepts them). */
export type VmProxySeams = Partial<
  Pick<VmEgressDeps, "resolve" | "connect" | "addressRefused" | "hostAddresses">
>;

export interface VmProxyContext {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Under Kata the bridge's host address and the proxy port; undefined: loopback, any port (the process backend, tests). */
  readonly bind: { readonly host: string; readonly port: number } | undefined;
  /** The agents' view, bound late: until then every source is refused (no host list). */
  late(): Pick<AgentsVmDerived, "hostsOf" | "trustedOf"> | null;
  readonly closers: Array<{ readonly name: string; close(): void | Promise<void> }>;
  readonly seams?: VmProxySeams | undefined;
}

/**
 * The egress proxy for the agents' VMs (spec §3): it learns each launch's address from the runtime, and `start()` listens
 * before the daemon accepts a connection, like the gateway but after the boot's stop of the VMs. A refusal goes to the sink
 * `bindRefusals` gives (the card and the Inbox item, built after this); until then it is logged. Content that is not clean
 * taints the launch's sessions through the sink `bindTaint` gives (spec §4); `join` tells the launch a session started in it.
 */
export function composeVmProxy(ctx: VmProxyContext) {
  const { clock, logger } = ctx;
  /** The agent's host list now: its own, else the owner's. Null before the late binding. */
  const hostsOf = (agentId: string): readonly string[] | null => ctx.late()?.hostsOf(agentId) ?? null;
  const launches = createLaunchAddresses();
  const launchTaint = createLaunchTaint();
  let taint: (sessionId: string) => void = (sessionId) =>
    logger.warn("egress_vm_taint_unbound", { sessionId });
  const taintAll = (sessionIds: readonly string[]): void => {
    for (const sessionId of sessionIds)
      try {
        taint(sessionId);
      } catch (error) {
        logger.warn("egress_vm_taint_failed", { sessionId, err: error });
      }
  };
  const bind = ctx.bind ?? { host: "127.0.0.1", port: 0 };
  let sink: (refusal: VmRefusal) => void = (refusal) => {
    const written = writtenEntries(hostsOf(refusal.agentId) ?? []);
    logger.warn("egress_vm_refused", {
      agentId: refusal.agentId,
      host: hostLabel(refusal.host, written),
      port: refusal.port,
      reason: refusal.reason,
    });
  };
  const egress = createVmEgress({
    clock,
    logger,
    resolve: async (host) => (await lookup(host, { all: true })).map((answer) => answer.address),
    connect: (ip, port) => connect({ host: ip, port }),
    addressRefused: vmAddressRefused,
    hostAddresses: hostAddressesNow,
    ...ctx.seams,
    scopeOf(address) {
      const launch = launches.scopeOf(address);
      const hosts = launch === null ? null : hostsOf(launch.agentId);
      return launch === null || hosts === null
        ? null
        : { ...launch, hosts, trustedSources: ctx.late()?.trustedOf(launch.agentId) ?? [] };
    },
    onRefusal: (refusal) => sink(refusal),
    onTaint: (launch) => taintAll(launchTaint.mark(launch.launchId)),
  });
  return {
    bindTaint: (handler: (sessionId: string) => void): void => void (taint = handler),
    /** A session started in the launch: it starts tainted when the launch's proxy already let unclean content through. */
    join(launchId: string, sessionId: string): void {
      if (launchTaint.join(launchId, sessionId)) taintAll([sessionId]);
    },
    bindRefusals: (handler: (refusal: VmRefusal) => void): void => void (sink = handler),
    /** Listens (the bridge address is up by now) and answers the port; its closer is registered once it does. */
    async start(): Promise<number> {
      const port = await egress.listen(bind.host, bind.port).catch((error: unknown) => {
        throw new Error(
          `the VMs' proxy cannot listen on ${bind.host}:${bind.port} (pap0 is made by pap-vmd: run \`sudo pap vm setup\`, start pap-vmd; or another process holds the port)`,
          { cause: error },
        );
      });
      ctx.closers.push({ name: "agent_vm_proxy", close: () => egress.close() });
      return port;
    },
    launched: (grant: LaunchGrant): void =>
      launches.add(grant.address, {
        agentId: grant.agentId,
        launchId: grant.launchId,
        source: grant.taskKey == null ? "thread" : { task: grant.taskKey },
      }),
    ended(launchId: string): void {
      launches.remove(launchId);
      launchTaint.ended(launchId);
    },
  };
}
