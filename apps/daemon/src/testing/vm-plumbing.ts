import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentsVm, AgentsVmSeams } from "../compose-agents-vm.ts";
import type { VmSpec } from "../modules/agent-vm/index.ts";
import type { TestDaemonOptions } from "./harness.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
/** The VM process's node flags: workers dial the gateway over TCP, so the tests' network guard cannot ride along. */
const VM_EXEC_ARGV = ["--conditions=development", "--disable-warning=ExperimentalWarning"];

export interface VmPlumbing {
  /** The daemon options that put the agents in the process backend: spread them into `startTestDaemon`. */
  readonly options: Pick<TestDaemonOptions, "config" | "deps">;
  /** The VMs the backend started and stopped, in order. */
  readonly vms: {
    readonly started: VmSpec[];
    readonly stopped: Array<{ agentId: string; taskKey: string | null }>;
  };
  /** The composition, set once the daemon is up. */
  exposed(): AgentsVm | undefined;
  dispose(): void;
}

/**
 * What a test daemon needs to run its agents on the process backend (the guest and its pi-host worker as local processes over
 * the real gateway, mirror and relay link): the config, the VM seams and the image folder the VM's Pi seeds from (R28).
 */
export function vmPlumbing(
  base: Pick<TestDaemonOptions, "config" | "deps"> = {},
  extra: {
    seams?: Partial<AgentsVmSeams>;
    imageFiles?: Readonly<Record<string, string>>;
    /** More guest environment (the fake `gh` of a GitHub journey). */
    guestEnv?: Readonly<Record<string, string>>;
  } = {},
): VmPlumbing {
  const image = mkdtempSync(join(tmpdir(), "pap-vm-image-"));
  mkdirSync(join(image, "extensions"), { recursive: true });
  writeFileSync(join(image, "settings.json"), "{}");
  for (const [file, content] of Object.entries(extra.imageFiles ?? {})) {
    mkdirSync(dirname(join(image, file)), { recursive: true });
    writeFileSync(join(image, file), content);
  }
  const vms: VmPlumbing["vms"] = { started: [], stopped: [] };
  let exposed: AgentsVm | undefined;
  return {
    options: {
      config: { testAgentRuntime: "process", ...base.config },
      deps: {
        ...base.deps,
        agentsVm: {
          process: {
            guestEntry: join(REPO, "packages/pi-host/src/guest/main.ts"),
            execArgv: VM_EXEC_ARGV,
            imageAgentSource: image,
            ...(extra.guestEnv ? { env: extra.guestEnv } : {}),
          },
          relayExecArgv: VM_EXEC_ARGV,
          expose: (vm) => void (exposed = vm),
          observe: {
            started: (spec) => void vms.started.push(spec),
            stopped: (box, taskKey) =>
              void (box.kind === "agent" && vms.stopped.push({ agentId: box.id, taskKey })),
          },
          ...extra.seams,
        },
      },
    },
    vms,
    exposed: () => exposed,
    dispose: () => rmSync(image, { recursive: true, force: true }),
  };
}
