import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import { createLaunchAddresses, type LaunchGrant } from "./modules/agent-vm/index.ts";
import {
  createVmEgress,
  hostAddressesNow,
  hostLabel,
  type VmRefusal,
  vmAddressRefused,
  writtenEntries,
} from "./modules/egress/index.ts";

export interface VmProxyContext {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Under Kata the bridge's host address and the proxy port; undefined: loopback, any port (the process backend, tests). */
  readonly bind: { readonly host: string; readonly port: number } | undefined;
  /** The agent's host list now: its own, else the owner's. Null before the late binding: every source is refused. */
  hostsOf(agentId: string): readonly string[] | null;
  readonly closers: Array<{ readonly name: string; close(): void | Promise<void> }>;
}

/**
 * The egress proxy for the agents' VMs (spec §3): it learns each launch's address from the runtime, and `start()` listens
 * before the daemon accepts a connection, like the gateway but after the boot's stop of the VMs. A refusal goes to the sink
 * `bindRefusals` gives (the card and the Inbox item, built after this); until then it is logged.
 */
export function composeVmProxy(ctx: VmProxyContext) {
  const { clock, logger } = ctx;
  const launches = createLaunchAddresses();
  const bind = ctx.bind ?? { host: "127.0.0.1", port: 0 };
  let sink: (refusal: VmRefusal) => void = (refusal) => {
    const written = writtenEntries(ctx.hostsOf(refusal.agentId) ?? []);
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
    scopeOf(address) {
      const launch = launches.scopeOf(address);
      const hosts = launch === null ? null : ctx.hostsOf(launch.agentId);
      return launch === null || hosts === null ? null : { ...launch, hosts };
    },
    onRefusal: (refusal) => sink(refusal),
  });
  return {
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
    ended: (launchId: string): void => launches.remove(launchId),
  };
}
