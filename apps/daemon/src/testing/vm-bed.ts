import { execFileSync } from "node:child_process";
import { AgentInput } from "@pap/contracts";
import type { AgentsVm, AgentsVmSeams } from "../compose-agents-vm.ts";
import type { VmSpec } from "../modules/agent-vm/index.ts";
import { type Owner, openOwner } from "../security/testing/automation-bed.ts";
import { callOf } from "../security/testing/agent-bed.ts";
import { type TestDaemon, type TestDaemonOptions, startTestDaemon } from "./harness.ts";
import { vmPlumbing } from "./vm-plumbing.ts";

export interface VmBed {
  /** The composition (the runtime, the relay link): set once the daemon is up. */
  readonly vm: AgentsVm;
  readonly t: TestDaemon;
  readonly owner: Owner;
  readonly call: ReturnType<typeof callOf>;
  /** The VMs the backend started and stopped, in order. */
  readonly vms: {
    readonly started: VmSpec[];
    readonly stopped: Array<{ agentId: string; taskKey: string | null }>;
  };
  /** Creates an agent (a CyberLooker-like one by default) and returns its id. */
  createAgent(input?: Record<string, unknown>): Promise<string>;
  /** Opens the agent's thread and subscribes to it; resolves its session id. */
  openThread(agentId: string): Promise<string>;
  stop(): Promise<void>;
}

/**
 * A whole daemon on the process backend (T7): the agent's guest and its pi-host worker run as local
 * processes over the real gateway, the mirror and the relay link, on the scripted provider. Nothing reaches the network.
 */
export async function startVmBed(
  script: object,
  options: Omit<TestDaemonOptions, "config"> & {
    config?: TestDaemonOptions["config"];
    seams?: Partial<AgentsVmSeams>;
    /** Files written into the image's Pi folder (`extensions/x.js`, `models.json`): the VM's Pi seeds from it (R28). */
    imageFiles?: Readonly<Record<string, string>>;
  } = {},
): Promise<VmBed> {
  const { seams, imageFiles, ...rest } = options;
  const plumbing = vmPlumbing({ config: rest.config, deps: rest.deps }, { seams, imageFiles });
  const { vms } = plumbing;
  let t: TestDaemon;
  try {
    t = await startTestDaemon(script, { ...rest, ...plumbing.options });
  } catch (error) {
    plumbing.dispose();
    throw error;
  }
  const daemon = t;
  const owner = await openOwner(daemon);
  const call = callOf(owner.client);
  const exposed = plumbing.exposed();
  if (exposed === undefined) throw new Error("the VM composition was not exposed");
  return {
    vm: exposed,
    t: daemon,
    owner,
    call,
    vms,
    async createAgent(input = {}) {
      const created = await call<{ id: string }>("agents.create", {
        input: AgentInput.parse({
          name: "CyberLooker",
          mode: "full-access",
          preset: "full",
          // The shell is pap's own in a VM, and its network is this switch (AVM2-E11): the proxy filters it.
          sandbox: { required: true, network: true },
          ...input,
        }),
      });
      return created.id;
    },
    async openThread(agentId) {
      const { sessionId } = await call<{ sessionId: string }>("agents.openThread", { agentId });
      await call("subscribe.session", { sessionId });
      return sessionId;
    },
    async stop() {
      owner.client.close();
      try {
        // The process backend makes each VM's image folder read-only (RT-07): the temporary home cannot be removed before this.
        execFileSync("chmod", ["-R", "u+w", daemon.root]);
        await daemon.stop();
      } finally {
        plumbing.dispose();
      }
    },
  };
}
