import { mkdirSync, rmSync } from "node:fs";
import { AGENT_NET, AgentId, TaskKey, VM_IPV4, type VmState } from "@pap/contracts";
import {
  directVolumeAddArgv,
  directVolumeRemoveArgv,
  inspectArgv,
  KATA_RUNTIME,
  pauseArgv,
  psArgv,
  rmArgv,
  runArgv,
  unpauseArgv,
  vmName,
  volumePath,
} from "./argv.ts";
import { VmdFailure } from "./errors.ts";
import { readNetFacts } from "./net-facts.ts";
import { fileExists, makeBlankDisk, removeTaskDir } from "./ops-disk.ts";
import type { OpsDeps, VmStartRequest } from "./ops.ts";

export type VmStateName = ReturnType<(typeof VmState)["parse"]>;
export interface VmEntry {
  readonly agentId: string;
  readonly taskKey: string | null;
  readonly state: VmStateName;
}

type Stop = { op: "vm.stop"; agentId: string; taskKey: string | null };
type Named = { agentId: string };
type Status = { agentId: string; taskKey: string | null };

const NAME = /^pap-(.+?)(?:-([0-9a-f]{32}))?$/;
const NO_SUCH_CONTAINER = /no such container/i;
/** Values that reach the env file: one visible token each, so no line break can enter (R8). */
const ENV_VALUE = /^[A-Za-z0-9._:-]+$/;

/** Maps `nerdctl ps` Status text; fails closed: anything not explicitly stopped counts as a VM that may hold its disk (I1). */
function stateOfStatus(status: string): VmStateName {
  if (/^Paused/i.test(status) || /\(Paused\)/i.test(status)) return "paused";
  if (/^(Created|Restarting)/i.test(status)) return "starting";
  // Only an explicit exit counts as stopped: Pausing, Unknown, an empty or a new status may still hold the disk.
  if (/^(Exited|Stopped)/i.test(status)) return "stopped";
  return "running";
}

const stateOfInspect = (text: string): VmStateName => {
  switch (text.trim()) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "created":
      return "starting";
    case "exited":
    case "stopped":
      return "stopped";
    default:
      // S1: an unknown or empty state may still hold the disk, like an unknown `ps` status (never "absent").
      return "running";
  }
};

export function parseVmList(text: string): VmEntry[] {
  const entries: VmEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const space = line.indexOf(" ");
    const match = NAME.exec(space === -1 ? line.trim() : line.slice(0, space));
    const agentId = match?.[1];
    const taskKey = match?.[2] ?? null;
    if (agentId === undefined || !AgentId.safeParse(agentId).success) continue;
    if (taskKey !== null && !TaskKey.safeParse(taskKey).success) continue;
    entries.push({
      agentId,
      taskKey,
      state: stateOfStatus(space === -1 ? "" : line.slice(space + 1).trim()),
    });
  }
  return entries;
}

export function createVmOps(deps: OpsDeps) {
  const { exec, net, state, locks, log } = deps;

  async function list(): Promise<VmEntry[]> {
    const result = await exec(psArgv());
    if (result.code !== 0) throw new VmdFailure("failed");
    return parseVmList(result.stdout);
  }

  /** Cleanup steps never stop each other: each failure is logged by name and the next step still runs. */
  async function step(name: string, run: () => Promise<unknown> | unknown): Promise<boolean> {
    try {
      if ((await run()) === false) {
        log.info("vmd_cleanup_failed", { step: name, error: "refused" });
        return false;
      }
      return true;
    } catch (error) {
      log.info("vmd_cleanup_failed", { step: name, error: error instanceof Error ? error.name : "unknown" });
      return false;
    }
  }

  /**
   * AVM-P16 (S1): a container whose `rm --force` failed may still bring up its veth, late, and bind the next VM's guard.
   * Its name stays listed until a removal works or `inspect` says it is stopped; the head of every start retries them.
   * Containers running without a lease at restore are listed from the start.
   */
  const unremoved = new Set<string>(deps.unleased ?? []);

  async function removeContainer(name: string): Promise<boolean> {
    const result = await exec(rmArgv(name));
    const removed = result.code === 0 || NO_SUCH_CONTAINER.test(result.stderr);
    if (removed) unremoved.delete(name);
    else unremoved.add(name);
    return removed;
  }

  /** Inside the start lock: retries each listed removal; a name that stays and is not stopped refuses the start. */
  async function retryUnremoved(): Promise<void> {
    for (const name of [...unremoved]) {
      if (await removeContainer(name)) continue;
      const inspected = await exec(inspectArgv(name));
      if (inspected.code === 0 && stateOfInspect(inspected.stdout) === "stopped") unremoved.delete(name);
      else {
        log.info("vmd_start_refused", { reason: "container_not_removed" });
        throw new VmdFailure("unavailable");
      }
    }
  }

  async function removeVolume(volume: string): Promise<void> {
    const result = await exec(directVolumeRemoveArgv(volume));
    if (result.code !== 0) log.info("vmd_volume_remove", { code: result.code });
    rmSync(volume, { recursive: true, force: true });
  }

  const succeed = (code: number): void => {
    if (code !== 0) throw new VmdFailure("failed");
  };

  async function startVm(request: VmStartRequest, name: string): Promise<{ address: string }> {
    const isolated = request.taskKey !== null;
    // R30: an isolated VM gets a blank disk of its own; the agent's disk is not even looked at.
    const disk = state.diskPath(request.agentId, request.taskKey);
    const volume = volumePath(deps.volumeRoot, name);
    const env = {
      PAP_GATEWAY: `${AGENT_NET.host}:${AGENT_NET.gatewayPort}`,
      PAP_GATEWAY_TOKEN: request.token,
      PAP_LAUNCH_ID: request.launchId,
      PAP_AGENT_ID: request.agentId,
      PAP_IMAGE_TAG: request.image,
    };
    if (!Object.values(env).every((value) => ENV_VALUE.test(value))) throw new VmdFailure("bad_request");
    if (isolated) await deps.room(request.resources.diskMb);
    else if (!fileExists(disk)) throw new VmdFailure("not_found");
    // AVM-E49: a VM without its ruleset and bridge would have the whole network to itself.
    const facts = await readNetFacts(exec);
    if (!facts.ruleset || !facts.bridge) {
      log.info("vmd_start_refused", { reason: facts.ruleset ? "no_bridge" : "no_ruleset" });
      throw new VmdFailure("unavailable");
    }
    let diskMade = false;
    /** Set by the cleanup inside the start lock: whether `rm --force` succeeded. The outer cleanup then does not repeat it. */
    let cleaned = null as boolean | null;
    try {
      const address = net.allocate(name);
      if (isolated) {
        diskMade = true;
        await makeBlankDisk(exec, disk, request.resources.diskMb);
      }
      // RT-33: a leftover container or volume of that name is cleared first.
      await exec(rmArgv(name));
      await exec(directVolumeRemoveArgv(volume));
      mkdirSync(volume, { recursive: true, mode: 0o700 });
      succeed((await exec(directVolumeAddArgv(volume, disk))).code);
      const envFile = state.writeEnvFile(
        request.launchId,
        `${Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")}\n`,
      );
      await locks.withStart(async () => {
        await retryUnremoved();
        try {
          // AVM-E37: the bridge's ports before this run; the VM's port is the one that is new afterwards.
          await net.prepare(name);
          try {
            const placement = {
              ip: address.ip,
              mac: address.mac,
              disk: ["-v", `${volume}:/agent`],
              envFile,
              runtime: KATA_RUNTIME,
            };
            succeed((await exec(runArgv(request, placement))).code);
          } finally {
            // R8: the token file is gone whatever `nerdctl run` did.
            state.removeEnvFile(request.launchId);
          }
          await net.attach(name, address);
        } catch (error) {
          // N1: a late veth of this VM must not show up after the lock is released and be taken by the next start.
          cleaned = await step("rm", () => removeContainer(name));
          await step("detach", () => net.detach(name));
          await step("volume", () => removeVolume(volume));
          throw error;
        }
      });
      return { address: address.ip };
    } catch (error) {
      let removed = cleaned;
      if (removed === null) {
        removed = await step("rm", () => removeContainer(name));
        await step("detach", () => net.detach(name));
        await step("volume", () => removeVolume(volume));
      }
      // As in vm.stop: a container that could not be removed may still hold the task disk.
      if (diskMade && removed) await step("task_disk", () => removeTaskDir(disk));
      state.removeEnvFile(request.launchId);
      throw error instanceof VmdFailure ? error : new VmdFailure("failed");
    }
  }

  async function start(request: VmStartRequest): Promise<{ address: string }> {
    const name = vmName(request.agentId, request.taskKey);
    const result = await locks.withAgent(request.agentId, () => startVm(request, name));
    if (!VM_IPV4.test(result.address)) throw new VmdFailure("failed");
    return result;
  }

  function stop(request: Stop): Promise<unknown> {
    const name = vmName(request.agentId, request.taskKey);
    const volume = volumePath(deps.volumeRoot, name);
    return locks.withAgent(request.agentId, async () => {
      // containerd forgets the token with the container (R8); a container already gone is fine.
      const removed = await removeContainer(name);
      const detached = await step("detach", () => net.detach(name));
      await step("volume", () => removeVolume(volume));
      // R30: a task's disk goes with its VM, but never while the container may still hold it.
      if (removed && request.taskKey !== null) {
        removeTaskDir(state.diskPath(request.agentId, request.taskKey));
      }
      if (!removed || !detached) throw new VmdFailure("failed");
      return { stopped: true };
    });
  }

  const control = (argv: (name: string) => string[]) => (request: Named) =>
    locks.withAgent(request.agentId, async () => {
      succeed((await exec(argv(vmName(request.agentId, null)))).code);
      return {};
    });

  async function status(request: Status): Promise<unknown> {
    const result = await exec(inspectArgv(vmName(request.agentId, request.taskKey)));
    return { state: result.code === 0 ? stateOfInspect(result.stdout) : "absent" };
  }

  return { start, stop, pause: control(pauseArgv), resume: control(unpauseArgv), status, list };
}
