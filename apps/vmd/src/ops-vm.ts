import { lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { AGENT_NET, boxKey, VM_IPV4, type BoxRef, type VmState } from "@pap/contracts";
import {
  directVolumeAddArgv,
  directVolumeRemoveArgv,
  inspectArgv,
  KATA_RUNTIME,
  pauseArgv,
  psArgv,
  rmArgv,
  diskFlags,
  runArgv,
  unpauseArgv,
  volumePath,
} from "./argv.ts";
import { parseVmName, sameBox, vmName } from "./box-name.ts";
import { VmdFailure } from "./errors.ts";
import { readNetFacts } from "./net-facts.ts";
import { fileExists, growKeptDisk, makeBlankDisk, removeTaskDir } from "./ops-disk.ts";
import { procHoldsFile, reclaimDisk } from "./ops-reclaim.ts";
import type { OpsDeps, VmStartRequest } from "./ops.ts";

export type VmStateName = ReturnType<(typeof VmState)["parse"]>;
export interface VmEntry {
  readonly box: BoxRef;
  readonly taskKey: string | null;
  readonly state: VmStateName;
}

type Stop = { op: "vm.stop"; box: BoxRef; taskKey: string | null };
type Named = { box: BoxRef };
type Status = { box: BoxRef; taskKey: string | null };

/** nerdctl 2.4.1, recorded on the real stack (T20a): `rm --force` and `pause` say "no such container: x", `inspect` says "no such object x". */
const NO_SUCH_CONTAINER = /no such container/i;
const NO_SUCH_INSPECTED = /no such (?:container|object)/i;
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
    const named = parseVmName(space === -1 ? line.trim() : line.slice(0, space));
    if (named === null) continue;
    entries.push({
      ...named,
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
        log.info("vmd_start_refused", { reason: "container_not_removed", vm: name });
        throw new VmdFailure("unavailable");
      }
    }
  }

  /**
   * T20a: pap-vmd's lease table decides each VM's address, and CNI's host-local only mirrors it in one file per address. A file
   * a teardown left behind makes `nerdctl run --ip` fail ("requested IP address is not available") for good, so the file of the
   * address just allocated is removed first. Inside the start lock: no other start is running.
   */
  function clearReservation(ip: string): void {
    const file = path.join(deps.ipamRoot, ip);
    try {
      lstatSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") log.info("vmd_ipam_reservation_unreadable", { ip, code: code ?? "unknown" });
      return;
    }
    rmSync(file, { force: true });
    log.info("vmd_ipam_reservation_cleared", { ip });
  }

  async function removeVolume(volume: string): Promise<void> {
    const result = await exec(directVolumeRemoveArgv(volume));
    if (result.code !== 0) log.info("vmd_volume_remove", { code: result.code });
    rmSync(volume, { recursive: true, force: true });
  }

  const succeed = (code: number): void => {
    if (code !== 0) throw new VmdFailure("failed");
  };

  /**
   * Kept disks held by a VM this pap-vmd started: container name -> its keep key. A stop (named by task key only) drops its
   * entry and never removes a kept folder; the name stays listed only while `nerdctl ps` shows the VM not stopped.
   */
  const keptVms = new Map<string, { box: BoxRef; keepKey: string }>();

  /** Whether a live VM, or any process, holds the kept disk. Fails closed: an unreadable `nerdctl ps` throws. */
  async function keptHeld(box: BoxRef, keepKey: string): Promise<boolean> {
    const mine = [...keptVms].filter(([, held]) => sameBox(held.box, box) && held.keepKey === keepKey);
    if (mine.length > 0) {
      const vms = await list();
      for (const [name] of mine) {
        const parsed = parseVmName(name);
        const live = vms.some(
          (vm) =>
            parsed !== null &&
            sameBox(vm.box, parsed.box) &&
            vm.taskKey === parsed.taskKey &&
            vm.state !== "stopped",
        );
        if (live) return true;
        keptVms.delete(name);
      }
    }
    const file = state.keptPath(box, keepKey);
    return fileExists(file) && (deps.holdsFile ?? procHoldsFile)(file);
  }

  async function startVm(request: VmStartRequest, name: string): Promise<{ address: string }> {
    const isolated = request.taskKey !== null;
    // R30: an isolated VM gets a blank disk of its own; the box's disk is not even looked at.
    const keepKey = request.keepKey ?? null;
    const disk =
      keepKey === null ? state.diskPath(request.box, request.taskKey) : state.keptPath(request.box, keepKey);
    const volume = volumePath(deps.volumeRoot, name);
    const env = {
      PAP_GATEWAY: `${AGENT_NET.host}:${AGENT_NET.gatewayPort}`,
      PAP_GUEST_PROXY: `${AGENT_NET.host}:${AGENT_NET.proxyPort}`,
      PAP_GATEWAY_TOKEN: request.token,
      PAP_LAUNCH_ID: request.launchId,
      PAP_BOX: boxKey(request.box),
      PAP_IMAGE_TAG: request.image,
    };
    if (!Object.values(env).every((value) => ENV_VALUE.test(value))) throw new VmdFailure("bad_request");
    // A kept start asks for room only when its disk is made (below); a held kept disk is refused before anything is touched.
    if (keepKey !== null && (await keptHeld(request.box, keepKey))) throw new VmdFailure("conflict");
    const diskExists = keepKey !== null && fileExists(disk);
    if (isolated && !diskExists) await deps.room(request.resources.diskMb);
    else if (!isolated && !fileExists(disk)) throw new VmdFailure("not_found");
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
      if (diskExists) {
        growKeptDisk(disk, request.resources.diskMb);
      } else if (isolated) {
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
          clearReservation(address.ip);
          try {
            const placement = {
              ip: address.ip,
              mac: address.mac,
              disk: diskFlags(request.box, volume),
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
      if (keepKey !== null) keptVms.set(name, { box: request.box, keepKey });
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
    const name = vmName(request.box, request.taskKey);
    const result = await locks.withBox(request.box, () => startVm(request, name));
    if (!VM_IPV4.test(result.address)) throw new VmdFailure("failed");
    return result;
  }

  /** Reclaim jobs not yet finished; `idle` waits for them (tests, and an orderly drain). */
  const reclaims = new Set<Promise<unknown>>();

  /**
   * A box's disk is sparse again once nothing holds it. Its own job, queued behind the stop under the box lock, so the stop
   * answers at once (a dig of a pre-allocated disk takes minutes). Every gate is checked again inside the lock: no live VM of the
   * box in `nerdctl ps`, no process holding the file. A start that arrives meanwhile waits for the dig. A job cut by a pap-vmd
   * exit is harmless: each punched hole is atomic and nothing is tracked on disk.
   */
  function scheduleReclaim(box: BoxRef): void {
    const job = locks
      .withBox(box, () =>
        step("reclaim", async () => {
          const vms = await list();
          const live = vms.some(
            (vm) => sameBox(vm.box, box) && vm.taskKey === null && vm.state !== "stopped",
          );
          if (live) return;
          await reclaimDisk(exec, log, state.diskPath(box, null), deps.holdsFile);
        }),
      )
      .catch(() => undefined)
      .finally(() => reclaims.delete(job));
    reclaims.add(job);
  }

  const idle = async (): Promise<void> => {
    while (reclaims.size > 0) await Promise.all([...reclaims]);
  };

  function stop(request: Stop): Promise<unknown> {
    const name = vmName(request.box, request.taskKey);
    const volume = volumePath(deps.volumeRoot, name);
    return locks.withBox(request.box, async () => {
      // A kept VM's folder is never removed here: only `tasks/<key>/` goes, and a kept start never made one.
      keptVms.delete(name);
      // containerd forgets the token with the container (R8); a container already gone is fine.
      const removed = await removeContainer(name);
      const detached = await step("detach", () => net.detach(name));
      await step("volume", () => removeVolume(volume));
      // AVM-E62: no `nerdctl run` may be creating a namespace file meanwhile, so the start lock is held.
      await step("netns", () => locks.withStart(async () => deps.sweepNetns?.()));
      // R30: a task's disk goes with its VM, but never while the container may still hold it.
      if (removed && request.taskKey !== null) {
        removeTaskDir(state.diskPath(request.box, request.taskKey));
      }
      if (removed && request.taskKey === null) scheduleReclaim(request.box);
      if (!removed || !detached) throw new VmdFailure("failed");
      return { stopped: true };
    });
  }

  const control = (argv: (name: string) => string[]) => (request: Named) =>
    locks.withBox(request.box, async () => {
      succeed((await exec(argv(vmName(request.box, null)))).code);
      return {};
    });

  async function status(request: Status): Promise<unknown> {
    const result = await exec(inspectArgv(vmName(request.box, request.taskKey)));
    if (result.code === 0) return { state: stateOfInspect(result.stdout) };
    // Only "no such container" is absent: a containerd or nerdctl failure says nothing about the VM (S1, fail closed).
    if (NO_SUCH_INSPECTED.test(result.stderr)) return { state: "absent" };
    throw new VmdFailure("failed");
  }

  return {
    idle,
    keptHeld,
    start,
    stop,
    pause: control(pauseArgv),
    resume: control(unpauseArgv),
    status,
    list,
  };
}
