import { type AgentResources, PapError, type VmLayout } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { Gateway } from "./gateway.ts";
import type { GuestLink } from "./guest-link.ts";
import { createCrashLog, createIdleStop, fitsCapacity, type IdleStop } from "./lifecycle.ts";
import type { LaunchTokens } from "./tokens.ts";
import type { PackagePicks, VmWorkerHandle, WorkerSpawnInput } from "./vm-worker.ts";

export type VmPhase = "stopped" | "starting" | "running" | "paused" | "stopping";

export interface VmSpec {
  readonly agentId: string;
  readonly kind: "thread" | "isolated";
  readonly taskKey: string | null;
  readonly image: string;
  readonly resources: AgentResources;
}

export interface LaunchGrant {
  readonly launchId: string;
  readonly agentId: string;
  readonly relayKey: string;
  /** The VM's bridge address from `vm.start` (127.0.0.1 under the process backend). */
  readonly address: string;
  /** The isolated task's key; null (or absent) for the agent's thread VM. The egress proxy names the source by it. */
  readonly taskKey?: string | null;
}

export interface AgentRuntimeBackend {
  /** Starts the VM; `address` is where the relay sees it. The backend may not answer for a guest that never dials. */
  start(spec: VmSpec, launch: { launchId: string; token: string }): Promise<{ address: string }>;
  /**
   * `launchId` names the launch this stop is for: a backend that knows its launches ignores a stop for one that is no longer
   * the current VM of the key (a late stop must never hit a fresh VM of the same key, AVM-E46). The boot's stops name none.
   */
  stop(agentId: string, taskKey: string | null, launchId?: string): Promise<void>;
  list(): Promise<Array<{ agentId: string; taskKey: string | null }>>;
}

export interface AgentRuntime {
  /** Starts the agent's VM if needed (one per agent; an isolated task gets its own) and a worker in it. Waits for boot's stopAll. */
  spawn(
    spec: VmSpec,
    worker: WorkerSpawnInput,
    packages: PackagePicks,
  ): Promise<{ handle: WorkerHandle & VmWorkerHandle; layout: VmLayout; relayKey: string; slot: string }>;
  phase(agentId: string): VmPhase;
  /** Stops every VM of the agent (its own and its isolated tasks'). */
  stop(agentId: string): Promise<void>;
  /** Boot (spec §8, decision 109 Q4): stop every VM the backend lists, before any spawn runs (RT-42). */
  stopAll(): Promise<void>;
  /** The image tag a launch started with: the gateway's `imageOf` (AVM-P8). */
  imageOf(launchId: string): string | null;
  /** The owner's Resume: forgets the crashes and lets the agent start VMs again (the persisted pause is the agent store's). */
  resume(agentId: string): void;
}

export interface AgentRuntimeDeps {
  backend: AgentRuntimeBackend;
  gateway: Pick<Gateway, "awaitGuest">;
  tokens: LaunchTokens;
  clock: Clock;
  logger: Logger;
  memoryCapMb: number;
  /** `PAP_WORKER_IDLE_MINUTES` in ms: a VM stops this long after its last worker; 0 never. */
  idleMs: number;
  /** Where things are in this backend's VM of `spec` (`layoutOf` bound to the backend and `$PAP_HOME`). */
  layout(spec: VmSpec): VmLayout;
  /** R13: the relay learns a launch at its start and forgets it at its stop (J1 wires the relay link). */
  onLaunch(grant: LaunchGrant): void;
  onLaunchEnd(launchId: string): void;
  /** 3 crashes in 10 minutes (RT-40): the agent's existing pause with the reason `crashed` and an Inbox item (AVM-P21). */
  onCrashPause(agentId: string): void;
  notifyCapacity(running: string[]): void;
}

interface Entry {
  readonly key: string;
  readonly spec: VmSpec;
  readonly launchId: string;
  readonly relayKey: string;
  readonly layout: VmLayout;
  readonly idle: IdleStop;
  readonly workers: Set<VmWorkerHandle>;
  phase: "starting" | "running" | "stopping";
  link: GuestLink | undefined;
  ready: Promise<GuestLink>;
  teardown: Promise<void> | undefined;
}

/** A function, so a check after an await is not narrowed by the checks before it. */
const isStopping = (entry: { phase: string }): boolean => entry.phase === "stopping";

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const { backend, gateway, tokens, clock, logger } = deps;
  const entries = new Map<string, Entry>();
  const images = new Map<string, string>();
  const paused = new Set<string>();
  const crashes = createCrashLog(clock);
  let boot: { state: "pending" | "ok" | "failed"; wake: () => void; settled: Promise<void> };
  const newBoot = (): void => {
    let wake: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      wake = resolve;
    });
    boot = { state: "pending", wake, settled };
  };
  newBoot();

  const keyOf = (spec: VmSpec): string => {
    if (spec.kind === "thread") return spec.agentId;
    if (spec.taskKey === null) throw new PapError("bad_request");
    return `${spec.agentId}\u0000${spec.taskKey}`;
  };
  const taskKeyOf = (spec: VmSpec): string | null => (spec.kind === "thread" ? null : spec.taskKey);

  async function tearDown(entry: Entry): Promise<void> {
    entry.teardown ??= (async () => {
      entry.phase = "stopping";
      entry.idle.cancel();
      await Promise.allSettled([...entry.workers].map((handle) => handle.stop()));
      entry.link?.shutdown();
      await stopLate(entry);
      tokens.revoke(entry.launchId);
      images.delete(entry.launchId);
      try {
        deps.onLaunchEnd(entry.launchId);
      } catch (error) {
        logger.warn("agent_vm_launch_end_failed", { agentId: entry.spec.agentId, err: error });
      }
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
    })();
    return entry.teardown;
  }

  /** Stops by launch, not by key: see `AgentRuntimeBackend.stop`. */
  async function stopLate(entry: Entry): Promise<void> {
    try {
      await backend.stop(entry.spec.agentId, taskKeyOf(entry.spec), entry.launchId);
    } catch (error) {
      logger.warn("agent_vm_stop_failed", { agentId: entry.spec.agentId, err: error });
    }
  }

  function onClosed(entry: Entry): void {
    if (isStopping(entry)) return;
    const hadWorkers = entry.idle.live > 0;
    const agentId = entry.spec.agentId;
    logger.warn("agent_vm_exited", { agentId, withWorkers: hadWorkers });
    if (hadWorkers && crashes.record(agentId) && !paused.has(agentId)) {
      paused.add(agentId);
      try {
        deps.onCrashPause(agentId);
      } catch (error) {
        logger.error("agent_vm_crash_pause_failed", { agentId, err: error });
      }
    }
    void tearDown(entry);
  }

  /** Synchronous up to the entry's insertion: two spawns cannot both pass the capacity check. */
  function startVm(spec: VmSpec, key: string): Entry {
    const running = [...entries.values()];
    if (
      !fitsCapacity(
        running.map((e) => e.spec.resources.memoryMb),
        spec.resources.memoryMb,
        deps.memoryCapMb,
      )
    ) {
      deps.notifyCapacity([...new Set(running.map((e) => e.spec.agentId))]);
      throw new PapError("capacity");
    }
    const issued = tokens.issue(spec.agentId);
    const entry: Entry = {
      key,
      spec,
      launchId: issued.launchId,
      relayKey: issued.relayKey,
      layout: deps.layout(spec),
      idle: createIdleStop(clock, deps.idleMs, () => void tearDown(entry)),
      workers: new Set(),
      phase: "starting",
      link: undefined,
      ready: new Promise<GuestLink>(() => {}), // replaced below, once the entry exists
      teardown: undefined,
    };
    entries.set(key, entry);
    images.set(entry.launchId, spec.image);
    entry.ready = (async () => {
      try {
        const { address } = await backend.start(spec, { launchId: entry.launchId, token: issued.token });
        if (isStopping(entry)) {
          // A stop arrived while the VM was starting: its teardown ran before the VM existed, so stop it now.
          await stopLate(entry);
          throw new PapError("worker_failed");
        }
        deps.onLaunch({
          launchId: entry.launchId,
          agentId: spec.agentId,
          relayKey: issued.relayKey,
          address,
          taskKey: taskKeyOf(spec),
        });
        const link = await gateway.awaitGuest(entry.launchId);
        if (isStopping(entry)) {
          link.shutdown();
          await stopLate(entry);
          throw new PapError("worker_failed");
        }
        entry.link = link;
        entry.phase = "running";
        void link.closed.then(() => onClosed(entry));
        return link;
      } catch (error) {
        await tearDown(entry);
        throw error;
      }
    })();
    entry.ready.catch(() => {});
    return entry;
  }

  return {
    async spawn(spec, worker, packages) {
      const key = keyOf(spec);
      while (boot.state === "pending") await boot.settled;
      if (boot.state === "failed") throw new PapError("worker_failed");
      if (paused.has(spec.agentId)) throw new PapError("agent_paused");
      let entry = entries.get(key);
      if (entry?.phase === "stopping") {
        await entry.teardown;
        entry = undefined;
      }
      entry ??= entries.get(key) ?? startVm(spec, key);
      const link = await entry.ready;
      if (isStopping(entry)) throw new PapError("worker_failed");
      entry.idle.workerStarted();
      let handle: VmWorkerHandle;
      try {
        handle = await link.spawnWorker({ ...worker, sessionsDir: entry.layout.sessions }, packages);
      } catch (error) {
        if (!isStopping(entry)) entry.idle.workerEnded();
        throw error;
      }
      entry.workers.add(handle);
      void handle.exited.then(() => {
        entry.workers.delete(handle);
        // A stopping entry has its idle timer cancelled for good: a worker leaving it must not arm one.
        if (!isStopping(entry)) entry.idle.workerEnded();
      });
      return { handle, layout: entry.layout, relayKey: entry.relayKey, slot: handle.slot };
    },
    phase(agentId) {
      if (paused.has(agentId)) return "paused";
      const mine = [...entries.values()].filter((e) => e.spec.agentId === agentId);
      return (mine.find((e) => e.spec.kind === "thread") ?? mine[0])?.phase ?? "stopped";
    },
    async stop(agentId) {
      await Promise.all([...entries.values()].filter((e) => e.spec.agentId === agentId).map(tearDown));
    },
    async stopAll() {
      try {
        await Promise.all([...entries.values()].map(tearDown));
        let failed: unknown;
        for (const vm of await backend.list()) {
          try {
            await backend.stop(vm.agentId, vm.taskKey);
          } catch (error) {
            failed ??= error;
            logger.error("agent_vm_boot_stop_failed", { agentId: vm.agentId, err: error });
          }
        }
        if (failed !== undefined) throw failed;
        boot.state = "ok";
      } catch (error) {
        boot.state = "failed";
        logger.error("agent_vm_boot_stop_failed", { err: error });
        throw error;
      } finally {
        boot.wake();
      }
    },
    imageOf: (launchId) => images.get(launchId) ?? null,
    resume(agentId) {
      paused.delete(agentId);
      crashes.clear(agentId);
    },
  };
}
