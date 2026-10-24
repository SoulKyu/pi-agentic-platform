import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type BoxRef, boxKey, type VmLayout } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { layoutOf } from "./layouts.ts";
import { projectLayoutOf as vmProjectLayoutOf } from "./project-layout.ts";
import type { AgentRuntimeBackend, VmSpec } from "./runtime.ts";

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
  /** `Config.testGithubOrigin`: the config value only, so a stray environment variable never reaches a guest. */
  readonly githubOrigin?: string | null;
  /** Test seam: more guest environment (the fake `gh` of a GitHub journey). Never read from the daemon's environment. */
  readonly guestEnv?: Readonly<Record<string, string>>;
  readonly clock: Clock;
  readonly logger: Logger;
}

const keyOf = (box: BoxRef, taskKey: string | null): string =>
  taskKey === null ? boxKey(box) : `${boxKey(box)}\u0000${taskKey}`;

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
    { box: BoxRef; taskKey: string | null; child: ChildProcess; gone: Promise<void> }
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

  async function stop(box: BoxRef, taskKey: string | null): Promise<void> {
    const entry = running.get(keyOf(box, taskKey));
    if (!entry) return;
    killGroup(entry.child, "SIGTERM");
    const timer = clock.setTimeout(() => killGroup(entry.child, "SIGKILL"), PROCESS_STOP_GRACE_MS);
    await entry.gone;
    clock.clearTimeout(timer);
  }

  /** Makes the box's folders, and gives the box a read-only copy of the test image's Pi folder (RT-07), as an agent's. */
  function prepare(spec: VmSpec): { root: string; home: string; guestLayout: VmLayout } {
    const guestLayout =
      spec.box.kind === "project"
        ? vmProjectLayoutOf("process", options.papHome, spec.box.id)
        : layoutOf("process", options.papHome, { agentId: spec.box.id, taskKey: spec.taskKey });
    const folders =
      guestLayout.project === undefined
        ? [guestLayout.home, guestLayout.knowledge, guestLayout.inbox]
        : [guestLayout.project, guestLayout.home, guestLayout.inbox];
    for (const dir of [...folders, guestLayout.sessions, guestLayout.piAgentDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (existsSync(guestLayout.imageAgentDir)) {
      chmodSync(guestLayout.imageAgentDir, 0o755);
      setMode(guestLayout.imageAgentDir, true);
      rmSync(guestLayout.imageAgentDir, { recursive: true, force: true });
    }
    cpSync(options.imageAgentSource, guestLayout.imageAgentDir, { recursive: true });
    setMode(guestLayout.imageAgentDir, false);
    chmodSync(guestLayout.imageAgentDir, 0o555);
    return { root: guestLayout.root, home: guestLayout.home, guestLayout };
  }

  return {
    start(spec, launch) {
      const { root, home, guestLayout } = prepare(spec);
      const run = join(root, "run");
      mkdirSync(run, { recursive: true, mode: 0o700 });
      const gateway = options.gatewayAddress();
      const proxy = options.proxyAddress();
      const key = keyOf(spec.box, spec.taskKey);
      const child = spawn(process.execPath, [...options.execArgv, options.guestEntry], {
        cwd: home,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          PAP_GATEWAY: `${gateway.host}:${gateway.port}`,
          PAP_GUEST_PROXY: `${proxy.host}:${proxy.port}`,
          PAP_GATEWAY_TOKEN: launch.token,
          PAP_LAUNCH_ID: launch.launchId,
          PAP_BOX: boxKey(spec.box),
          PAP_IMAGE_TAG: spec.image,
          // AVM-E11: what `pap-guest` reads instead of Kata's fixed `/agent` and `/run`.
          PAP_GUEST_LAYOUT: JSON.stringify(guestLayout),
          PAP_GUEST_RUN_DIR: run,
          PAP_TEST_PROVIDER_SCRIPT: options.providerScript,
          // The fake GitHub's origin (tests only, this backend only): Kata's guest never gets it, so it refuses loopback and file URLs.
          ...(options.githubOrigin == null ? {} : { PAP_TEST_GITHUB_ORIGIN: options.githubOrigin }),
          ...options.guestEnv,
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
          logger.warn("agent_vm_process_error", { box: boxKey(spec.box), err: error });
          if (running.get(key)?.child === child) running.delete(key);
          resolve();
        });
      });
      running.set(key, { box: spec.box, taskKey: spec.taskKey, child, gone });
      return Promise.resolve({ address: "127.0.0.1" });
    },
    stop,
    list: () => Promise.resolve([...running.values()].map(({ box, taskKey }) => ({ box, taskKey }))),
  };
}
