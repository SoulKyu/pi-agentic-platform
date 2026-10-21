import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { layoutOf } from "./layouts.ts";
import type { AgentRuntimeBackend } from "./runtime.ts";

/** How long a guest has to leave after SIGTERM before its group gets SIGKILL. */
export const PROCESS_STOP_GRACE_MS = 5000;

export interface ProcessBackendOptions {
  /** `PAP_TEST_AGENT_RUNTIME`: anything but `process` refuses to build the backend. */
  readonly testSwitch: string | null;
  readonly papHome: string;
  /** The guest's entry (`pap-guest`, lane A) and the node flags it needs. */
  readonly guestEntry: string;
  readonly execArgv: readonly string[];
  /** A folder holding the test image's Pi agent folder: copied into the VM's `imageAgentDir`, read-only. */
  readonly imageAgentSource: string;
  /** Where the daemon's gateway listens (known once it is listening). */
  gatewayAddress(): { host: string; port: number };
  /** Where the daemon's VM egress proxy listens (known once it is listening): the guest's `PAP_GUEST_PROXY` (`host:port`, as `PAP_GATEWAY`). */
  proxyAddress(): { host: string; port: number };
  /** `PAP_TEST_PROVIDER_SCRIPT`, passed on to the workers the guest starts. */
  readonly providerScript: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

const keyOf = (agentId: string, taskKey: string | null): string =>
  taskKey === null ? agentId : `${agentId}\u0000${taskKey}`;

/** Folders 0555 and files 0444 (`writable`: 0755 and 0644 again, so the folder can be replaced): a write Pi would make there fails, as on Kata's read-only root (RT-07). */
function setMode(dir: string, writable: boolean): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (writable) chmodSync(path, 0o755);
      setMode(path, writable);
      if (!writable) chmodSync(path, 0o555);
    } else if (entry.isFile()) chmodSync(path, writable ? 0o644 : 0o444);
  }
}

/** Tests only (`PAP_TEST_AGENT_RUNTIME=process`): the guest runs as a local process over the same gateway, its `/agent` a temp folder. */
export function createProcessBackend(options: ProcessBackendOptions): AgentRuntimeBackend {
  if (options.testSwitch !== "process")
    throw new Error("the process backend needs PAP_TEST_AGENT_RUNTIME=process");
  const { clock, logger } = options;
  const running = new Map<
    string,
    { agentId: string; taskKey: string | null; child: ChildProcess; gone: Promise<void> }
  >();

  const killGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined || pid <= 1) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  };

  async function stop(agentId: string, taskKey: string | null): Promise<void> {
    const entry = running.get(keyOf(agentId, taskKey));
    if (!entry) return;
    killGroup(entry.child, "SIGTERM");
    const timer = clock.setTimeout(() => killGroup(entry.child, "SIGKILL"), PROCESS_STOP_GRACE_MS);
    await entry.gone;
    clock.clearTimeout(timer);
  }

  return {
    start(spec, launch) {
      const layout = layoutOf("process", options.papHome, spec);
      for (const dir of [layout.home, layout.knowledge, layout.inbox, layout.sessions, layout.piAgentDir]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const run = join(layout.root, "run");
      mkdirSync(run, { recursive: true, mode: 0o700 });
      if (existsSync(layout.imageAgentDir)) {
        chmodSync(layout.imageAgentDir, 0o755);
        setMode(layout.imageAgentDir, true);
        rmSync(layout.imageAgentDir, { recursive: true, force: true });
      }
      cpSync(options.imageAgentSource, layout.imageAgentDir, { recursive: true });
      setMode(layout.imageAgentDir, false);
      chmodSync(layout.imageAgentDir, 0o555);
      const gateway = options.gatewayAddress();
      const proxy = options.proxyAddress();
      const key = keyOf(spec.agentId, spec.taskKey);
      const child = spawn(process.execPath, [...options.execArgv, options.guestEntry], {
        cwd: layout.home,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: layout.home,
          PAP_GATEWAY: `${gateway.host}:${gateway.port}`,
          PAP_GUEST_PROXY: `${proxy.host}:${proxy.port}`,
          PAP_GATEWAY_TOKEN: launch.token,
          PAP_LAUNCH_ID: launch.launchId,
          PAP_AGENT_ID: spec.agentId,
          PAP_IMAGE_TAG: spec.image,
          // AVM-E11: what `pap-guest` reads instead of Kata's fixed `/agent` and `/run`.
          PAP_GUEST_LAYOUT: JSON.stringify(layout),
          PAP_GUEST_RUN_DIR: run,
          PAP_TEST_PROVIDER_SCRIPT: options.providerScript,
          // The scripted provider's worker needs these (ADR 0001); the init names the script's VM path (AVM-E15).
          PAP_TEST_PROVIDER: "1",
          PI_OFFLINE: "1",
        },
      });
      child.stdout?.resume();
      child.stderr?.resume();
      const gone = new Promise<void>((resolve) => {
        child.once("exit", () => {
          if (running.get(key)?.child === child) running.delete(key);
          resolve();
        });
        child.once("error", (error) => {
          logger.warn("agent_vm_process_error", { agentId: spec.agentId, err: error });
          if (running.get(key)?.child === child) running.delete(key);
          resolve();
        });
      });
      running.set(key, { agentId: spec.agentId, taskKey: spec.taskKey, child, gone });
      return Promise.resolve({ address: "127.0.0.1" });
    },
    stop,
    list: () => Promise.resolve([...running.values()].map(({ agentId, taskKey }) => ({ agentId, taskKey }))),
  };
}
