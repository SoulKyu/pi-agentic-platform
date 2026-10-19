import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentInput } from "@pap/contracts";
import type { AgentsVm, AgentsVmSeams } from "../compose-agents-vm.ts";
import type { VmSpec } from "../modules/agent-vm/index.ts";
import { type Owner, openOwner } from "../security/testing/automation-bed.ts";
import { callOf } from "../security/testing/agent-bed.ts";
import { type TestDaemon, type TestDaemonOptions, startTestDaemon } from "./harness.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
/** The VM process's node flags: workers dial the gateway over TCP, so the tests' network guard cannot ride along. */
const VM_EXEC_ARGV = ["--conditions=development", "--disable-warning=ExperimentalWarning"];

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
 * A whole daemon in `PAP_AGENTS_RUNTIME=vm` on the process backend (T7): the agent's guest and its pi-host worker run as local
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
  const image = mkdtempSync(join(tmpdir(), "pap-vm-image-"));
  mkdirSync(join(image, "extensions"), { recursive: true });
  writeFileSync(join(image, "settings.json"), "{}");
  for (const [file, content] of Object.entries(imageFiles ?? {})) {
    mkdirSync(dirname(join(image, file)), { recursive: true });
    writeFileSync(join(image, file), content);
  }
  const vms: VmBed["vms"] = { started: [], stopped: [] };
  let t: TestDaemon | undefined;
  let exposed: AgentsVm | undefined;
  try {
    t = await startTestDaemon(script, {
      ...rest,
      config: { agentsRuntime: "vm", testAgentRuntime: "process", ...options.config },
      deps: {
        ...options.deps,
        agentsVm: {
          process: {
            guestEntry: join(REPO, "packages/pi-host/src/guest/main.ts"),
            execArgv: VM_EXEC_ARGV,
            imageAgentSource: image,
          },
          relayExecArgv: VM_EXEC_ARGV,
          expose: (vm) => void (exposed = vm),
          observe: {
            started: (spec) => void vms.started.push(spec),
            stopped: (agentId, taskKey) => void vms.stopped.push({ agentId, taskKey }),
          },
          ...seams,
        },
      },
    });
  } catch (error) {
    rmSync(image, { recursive: true, force: true });
    throw error;
  }
  const daemon = t;
  const owner = await openOwner(daemon);
  const call = callOf(owner.client);
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
          // A host sandbox profile with network: in a VM the shell is pap's own, without network, whatever this says (R15).
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
        rmSync(image, { recursive: true, force: true });
      }
    },
  };
}
