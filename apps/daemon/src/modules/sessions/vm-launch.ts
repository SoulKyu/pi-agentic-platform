import { type BoxRef, boxKey, type InitRecord, PapError, TaskKey, type VmLayout } from "@pap/contracts";
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
import type { ProjectLaunch } from "./project-gate.ts";
import type { SessionRow } from "./store.ts";

/** The image's bwrap (the guest runs it as root, R2). */
export const VM_BWRAP = "/usr/bin/bwrap";
/** AVM-P3: T0a recorded that virtio-fs refuses the overlay. */
export const VM_ROOT_VIEW = "read-only" as const;

/** Stand-ins for the relay key and the slot, which exist only once the VM has a worker: the check before the spawn does not read them. */
const CHECK_RELAY_KEY = "0".repeat(64);
const CHECK_SLOT = "0".repeat(32);

/** What a VM worker's mirror needs of the sessions module: the inputs of a row (T9b); `resources` bound the agent's mirrors (R32). */
export interface MirrorInputs {
  inputFor(row: SessionRow, resources?: { readonly diskMb: number }): WorkerSpawnInput;
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
   * Starts the agent's VM (or the project's box) if needed and a worker in it. The VM's `init` is checked first (host rules or paths refuse the
   * launch with nothing spawned); it is sent by the session's own start, never the host's.
   */
  spawn(row: SessionRow, launch: AgentLaunch | ProjectLaunch, init: InitRecord): Promise<VmStarted>;
}

export interface VmLaunchDeps {
  readonly runtime: Pick<AgentRuntime, "spawn">;
  readonly papHome: string;
  /** The shared VM predicate: the row's layout, null for a host row. */
  layoutOf(row: SessionRow): VmLayout | null;
  /**
   * Joins the session to the VM launch it runs in: the proxy taints the launch's sessions together (spec §4). `project` is set
   * for a project box's session, whose own taint (a task that starts tainted, a worker's report) taints the launch too.
   */
  joinLaunch(launchId: string, sessionId: string, project?: { readonly ownerId: string }): void;
  /** The image tag the agent's VM starts with (Kata: built first when it must be, so it may take minutes). */
  imageTagOf(
    agentId: string,
    input: AgentLaunch["input"],
    kind: "thread" | "isolated",
  ): string | Promise<string>;
  /**
   * Called after the image wait (a first build takes minutes) and the package helper, just before the VM starts: throws when the agent was quarantined
   * or deleted meanwhile, so the launch ends with no VM instead of a VM nobody uses (S1).
   */
  recheck?(ownerId: string, agentId: string): void;
  readonly mirrors: MirrorInputs;
  /**
   * The image a project's box starts with (the project's own, task A6); absent: a project row is refused. May build, so it may
   * take minutes.
   */
  projectImageTagOf?(projectId: string): string | Promise<string>;
  /** Like `recheck`, for a box: throws when the project was deleted or began to be deleted meanwhile. */
  recheckProject?(ownerId: string, projectId: string): void;
  readonly logger: Pick<Logger, "warn">;
  /** The exact sources of the agent's package picks (it holds ids, AVM-E33); `null` stays `null` (every package). */
  packageSources(ids: readonly string[] | null): Promise<string[] | null>;
  /** AVM-E42: the sources become the entries the launch's image wrote for them (the guest picks by those). */
  toImageEntries(agentId: string, image: string, sources: readonly string[] | null): string[] | null;
  /**
   * Process backend only (AVM-E15, tests): copies the scripted provider into the VM's folder and answers its VM path, which the
   * init carries as `testProviderScript`. Kata never runs a test script, so it is left out there.
   */
  copyProviderScript?(layout: VmLayout): string;
}

/** An isolated task's key in its VM's name: its session id without dashes; null for every other session. */
export const taskKeyOf = (row: Pick<SessionRow, "agentRole" | "id">): string | null =>
  row.agentRole === "task" ? row.id.replaceAll("-", "") : null;

/** Which of an agent's VMs the row runs in; refused before anything is built for it. */
function whoOf(row: SessionRow): Pick<VmSpec, "box" | "kind" | "taskKey"> {
  const { agentId } = row;
  if (agentId === undefined) throw new PapError("internal");
  const box: BoxRef = { kind: "agent", id: agentId };
  const key = taskKeyOf(row);
  if (key === null) return { box, kind: "thread", taskKey: null };
  const taskKey = TaskKey.safeParse(key);
  if (!taskKey.success) throw new PapError("bad_request");
  return { box, kind: "isolated", taskKey: taskKey.data };
}

/** What differs between an agent's launch and a project box's: the box, its resources, the image, the picks and the recheck. */
interface BoxPlan {
  readonly who: Pick<VmSpec, "box" | "kind" | "taskKey">;
  readonly mirrorRow: SessionRow & { readonly projectId?: string };
  readonly resources: VmSpec["resources"];
  readonly claudeEnv: Readonly<Record<string, string>> | undefined;
  image(): string | Promise<string>;
  packages(image: string): Promise<string[] | null>;
  recheck(): void;
}

function planOf(deps: VmLaunchDeps, row: SessionRow, launch: AgentLaunch | ProjectLaunch): BoxPlan {
  if ("project" in launch) {
    const projectId = launch.project.id;
    // One VM per project: every row of a box, a task's included, runs in the thread-kind VM with no task key.
    if (row.agentId !== undefined) throw new PapError("internal");
    return {
      who: { box: { kind: "project", id: projectId }, kind: "thread", taskKey: null },
      mirrorRow: { ...row, projectId },
      resources: launch.resources,
      claudeEnv: launch.claudeEnv,
      image() {
        if (deps.projectImageTagOf === undefined) throw new PapError("sandbox_unavailable");
        return deps.projectImageTagOf(projectId);
      },
      // A box's packages are its image's (task A6): the guest keeps every package the image holds.
      packages: async () => null,
      recheck: () => deps.recheckProject?.(row.ownerId, projectId),
    };
  }
  const { agentId } = row;
  if (agentId === undefined) throw new PapError("internal");
  const who = whoOf(row);
  return {
    who,
    mirrorRow: row,
    resources: launch.input.resources,
    claudeEnv: launch.claudeEnv,
    image: () => deps.imageTagOf(agentId, launch.input, who.kind),
    packages: async (image) =>
      deps.toImageEntries(agentId, image, await deps.packageSources(launch.input.packages)),
    recheck: () => deps.recheck?.(row.ownerId, agentId),
  };
}

export function createVmLaunch(deps: VmLaunchDeps): VmLaunch {
  return {
    async spawn(row, launch, init) {
      if (launch.vm !== true) throw new PapError("internal");
      const plan = planOf(deps, row, launch);
      const layout = deps.layoutOf(row);
      if (layout === null) throw new PapError("internal");
      const file = mirrorFileOf(deps.papHome, plan.mirrorRow);
      const fixed = { bwrap: VM_BWRAP, rootView: VM_ROOT_VIEW };
      // Fail closed before anything starts: host rules, a host path or no sandbox in the init refuse the launch here.
      try {
        vmInitOf(init, { layout, ...fixed, relayKey: CHECK_RELAY_KEY, slot: CHECK_SLOT }, file);
      } catch (error) {
        deps.logger.warn("agent_vm_init_refused", { box: boxKey(plan.who.box) });
        throw error;
      }
      const image = await plan.image();
      const spec: VmSpec = { ...plan.who, image, resources: plan.resources };
      const worker = {
        ...deps.mirrors.inputFor(plan.mirrorRow, plan.resources),
        sessionsDir: layout.sessions,
        ...(plan.claudeEnv ? { env: plan.claudeEnv } : {}),
      };
      const packages = await plan.packages(image);
      // Just before the runtime starts. `runtime.spawn` can still await (the boot, or the teardown of this key's previous VM) before
      // it has an entry a quarantine could stop: that residual leaves a VM up until its idle stop (resources only), and is accepted.
      plan.recheck();
      const started = await deps.runtime.spawn(spec, worker, packages);
      const { handle } = started;
      deps.joinLaunch(
        started.launchId,
        row.id,
        plan.who.box.kind === "project" ? { ownerId: row.ownerId } : undefined,
      );
      return {
        handle,
        bind(compose) {
          try {
            const composed = compose();
            const vm = { layout: started.layout, ...fixed, relayKey: started.relayKey, slot: started.slot };
            const init = vmInitOf(composed.init, vm, file);
            if (deps.copyProviderScript) init.testProviderScript = deps.copyProviderScript(started.layout);
            return { ...composed, init };
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
  launch: Pick<AgentLaunch | ProjectLaunch, "vm"> | null,
  vmLaunch: VmLaunch | undefined,
): VmLaunch | null {
  const gated = launch?.vm === true;
  if (vmRow !== gated) throw new PapError("internal");
  if (!vmRow) return null;
  if (vmLaunch === undefined) throw new PapError("internal");
  return vmLaunch;
}
