import { type InitRecord, PapError, TaskKey, type VmLayout } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import {
  type AgentRuntime,
  mirrorFileOf,
  vmInitOf,
  type VmSpec,
  type WorkerSpawnInput,
} from "../agent-vm/index.ts";
import type { AgentLaunch } from "./agent-gate.ts";
import type { SessionRow } from "./store.ts";

/** The image's bwrap (the guest runs it as root, R2). */
export const VM_BWRAP = "/usr/bin/bwrap";
/** AVM-P3: T0a recorded that virtio-fs refuses the overlay. */
export const VM_ROOT_VIEW = "read-only" as const;

/** Stand-ins for the relay key and the slot, which exist only once the VM has a worker: the check before the spawn does not read them. */
const CHECK_RELAY_KEY = "0".repeat(64);
const CHECK_SLOT = "0".repeat(32);

/** What a VM worker's mirror needs of the sessions module: T9b's inputs of a row (until it lands, a stub that refuses appends). */
export interface MirrorInputs {
  inputFor(row: SessionRow): WorkerSpawnInput;
}

/** A VM worker, spawned and not yet told its `init`. */
export interface VmStarted {
  readonly handle: WorkerHandle;
  /**
   * Runs `compose` (the host record, read now: nothing awaits between this and the session's start) and returns what it
   * answered with its `init` made the VM's. Stops the worker when either throws. Call it once.
   */
  bind<T extends { readonly init: InitRecord }>(compose: () => T): T;
}

export interface VmLaunch {
  /**
   * Starts the agent's VM if needed and a worker in it. The VM's `init` is checked first (host rules or paths refuse the
   * launch with nothing spawned); it is sent by the session's own start, never the host's.
   */
  spawn(row: SessionRow, launch: AgentLaunch, init: InitRecord): Promise<VmStarted>;
}

export interface VmLaunchDeps {
  readonly runtime: Pick<AgentRuntime, "spawn">;
  readonly papHome: string;
  /** The shared VM predicate: the row's layout, null for a host row. */
  layoutOf(row: SessionRow): VmLayout | null;
  /** The image tag the agent's VM starts with. */
  imageTagOf(agentId: string): string;
  readonly mirrors: MirrorInputs;
  readonly logger: Pick<Logger, "warn">;
}

/** An isolated task's key in its VM's name: its session id without dashes; null for every other session. */
export const taskKeyOf = (row: Pick<SessionRow, "agentRole" | "id">): string | null =>
  row.agentRole === "task" ? row.id.replaceAll("-", "") : null;

function specOf(row: SessionRow, launch: AgentLaunch, image: string): VmSpec {
  const { agentId } = row;
  if (agentId === undefined) throw new PapError("internal");
  const { resources } = launch.input;
  const key = taskKeyOf(row);
  if (key === null) return { agentId, kind: "thread", taskKey: null, image, resources };
  const taskKey = TaskKey.safeParse(key);
  if (!taskKey.success) throw new PapError("bad_request");
  return { agentId, kind: "isolated", taskKey: taskKey.data, image, resources };
}

export function createVmLaunch(deps: VmLaunchDeps): VmLaunch {
  return {
    async spawn(row, launch, init) {
      if (row.agentId === undefined || launch.vm !== true) throw new PapError("internal");
      const layout = deps.layoutOf(row);
      if (layout === null) throw new PapError("internal");
      const file = mirrorFileOf(deps.papHome, row);
      const fixed = { bwrap: VM_BWRAP, rootView: VM_ROOT_VIEW };
      // Fail closed before anything starts: host rules, a host path or no sandbox in the init refuse the launch here.
      try {
        vmInitOf(init, { layout, ...fixed, relayKey: CHECK_RELAY_KEY, slot: CHECK_SLOT }, file);
      } catch (error) {
        deps.logger.warn("agent_vm_init_refused", { agentId: row.agentId });
        throw error;
      }
      const spec = specOf(row, launch, deps.imageTagOf(row.agentId));
      const worker = { ...deps.mirrors.inputFor(row), sessionsDir: layout.sessions };
      const started = await deps.runtime.spawn(spec, worker, launch.input.packages);
      const { handle } = started;
      return {
        handle,
        bind(compose) {
          try {
            const composed = compose();
            const vm = { layout: started.layout, ...fixed, relayKey: started.relayKey, slot: started.slot };
            return { ...composed, init: vmInitOf(composed.init, vm, file) };
          } catch (error) {
            void handle.stop();
            throw error;
          }
        },
      };
    },
  };
}

/**
 * The one decision of the launch: a VM row (`vmRow`, the shared `vmLayoutOf(row) !== null`) starts through the launcher, a
 * host row through `deps.spawn`. The gate's answer and the launcher must agree with the predicate; any disagreement is a
 * wiring bug and refuses the launch rather than put a VM row on the host (or the reverse).
 */
export function vmBranchOf(
  vmRow: boolean,
  launch: Pick<AgentLaunch, "vm"> | null,
  vmLaunch: VmLaunch | undefined,
): VmLaunch | null {
  const gated = launch?.vm === true;
  if (vmRow !== gated) throw new PapError("internal");
  if (!vmRow) return null;
  if (vmLaunch === undefined) throw new PapError("internal");
  return vmLaunch;
}
