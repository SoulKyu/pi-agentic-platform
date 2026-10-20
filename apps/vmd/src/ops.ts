import type { VmdRequest } from "@pap/contracts";
import type { Clock } from "./clock.ts";
import { VmdFailure } from "./errors.ts";
import type { Locks } from "./locks.ts";
import type { Logger } from "./log.ts";
import { createDiskOps } from "./ops-disk.ts";
import { createImageOps } from "./ops-image.ts";
import { createVmOps } from "./ops-vm.ts";
import type { RunningTask, VmdState } from "./state.ts";

export type VmStartRequest = Extract<VmdRequest, { op: "vm.start" }>;
export type ImageBuildRequest = Extract<VmdRequest, { op: "image.build" }>;

export const VMD_VERSION = "1.0.0";
/** AVM-E31: `pap vm setup` installs the pinned agent bundle here, root-owned; the base image is built from it. */
export const BUNDLE_ROOT = "/opt/pap-vm/agent-bundle";
/** AVM-P13: each VM's direct-assigned volume is registered with Kata under this folder. */
export const VOLUME_ROOT = "/run/pap-vm/vol";
/** T20a: host-local's reservations (one file per address); `pap vm setup` points the conflist's `dataDir` at this folder's parent. */
export const IPAM_ROOT = "/run/pap-vm/cni-ipam/pap-agents";

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
/** Runs one program (`argv[0]`) with fixed arguments, never through a shell; resolves with the exit code, never rejects. */
export type Exec = (
  argv: readonly string[],
  options?: { readonly timeoutMs?: number },
) => Promise<ExecResult>;

/** AVM-P11: T16a's network port. `allocate` picks the VM's address and MAC (R22); `attach` and `detach` fill and empty the guard set. */
export interface NetPort {
  /** Reserves the VM's address and MAC (persisted); `detach(name)` frees it, bound or not. */
  allocate(name: string): { ip: string; mac: string };
  /** AVM-E37: inside the start mutex, before `nerdctl run`: records the bridge ports that exist now, so `attach` takes only a new one. */
  prepare(name: string): Promise<void>;
  attach(name: string, address: { ip: string; mac: string }): Promise<void>;
  detach(name: string): Promise<void>;
  /** Re-adds the guards of the VMs that run; resolves with the names of running containers that hold no lease. */
  restore(): Promise<readonly string[]>;
}

export interface OpsDeps {
  readonly exec: Exec;
  readonly net: NetPort;
  readonly state: VmdState;
  readonly locks: Locks;
  /** `createRoomCheck`: `disk_low` when the state folder lacks room for the operation plus the floor. */
  readonly room: (needMb: number) => Promise<void>;
  readonly clock: Clock;
  readonly log: Logger;
  /** The uid of pap's user: the only owner a tree copied from `$PAP_HOME` may have (R3). */
  readonly papUid: number;
  readonly papHome: string;
  /** `BUNDLE_ROOT` and the uid that must own it (root); tests inject a temp folder and their own uid. */
  readonly bundleRoot: string;
  readonly bundleUid: number;
  readonly volumeRoot: string;
  /** CNI's reservation folder for the agent network: pap-vmd's own address table is the authority (see `vm.start`). */
  readonly ipamRoot: string;
  readonly version: string;
  /** Running containers without a lease at restore (`net.restore`): listed like a failed removal, so no start runs beside them. */
  readonly unleased?: readonly string[];
  /** AVM-E62: removes the `cnitest-*` namespace files nobody mounts; run under the start lock after each `vm.stop`. */
  readonly sweepNetns?: () => number;
}

export interface Ops {
  /** One validated request in, its result out; a thrown `VmdFailure` is the typed refusal. */
  handle(request: VmdRequest): Promise<unknown>;
  /** The task VMs that exist and are not stopped: the start sweep keeps their disks. */
  runningTasks(): Promise<RunningTask[]>;
}

export function createOps(deps: OpsDeps): Ops {
  const vm = createVmOps(deps);
  const disk = createDiskOps(deps, vm.list);
  const image = createImageOps(deps);
  const { locks, state } = deps;

  function handle(request: VmdRequest): Promise<unknown> {
    switch (request.op) {
      case "vm.start":
        return vm.start(request);
      case "vm.stop":
        return vm.stop(request);
      case "vm.pause":
        return vm.pause(request);
      case "vm.resume":
        return vm.resume(request);
      case "vm.status":
        return vm.status(request);
      case "vm.list":
        return vm.list().then((vms) => ({ vms }));
      case "disk.create":
        return disk.create(request);
      case "disk.grow":
        return disk.grow(request);
      case "disk.delete":
        return disk.remove(request);
      case "disk.populate":
        return disk.populate(request);
      case "trash.purge": {
        const purge = (): Promise<unknown> => Promise.resolve({ removed: state.purgeTrash(request.agentId) });
        return request.agentId === null ? purge() : locks.withAgent(request.agentId, purge);
      }
      case "image.build":
        return image.build(request);
      case "image.list":
        return image.list();
      case "image.prune":
        return image.prune(request);
      case "version":
        return Promise.resolve({ version: deps.version });
      case "vmd.health":
        return image.health();
      default:
        return Promise.reject(new VmdFailure("bad_request"));
    }
  }

  return {
    handle,
    async runningTasks() {
      const vms = await vm.list();
      return vms.flatMap((entry) =>
        entry.taskKey !== null && entry.state !== "stopped"
          ? [{ agentId: entry.agentId, taskKey: entry.taskKey }]
          : [],
      );
    },
  };
}
