import { type AgentResources, type BoxRef, boxKey, PapError, type VmLayout } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { Gateway } from "./gateway.ts";
import type { GuestLink } from "./guest-link.ts";
import { createCrashLog, createIdleStop, fitsCapacity, type IdleStop } from "./lifecycle.ts";
import type { LaunchTokens } from "./tokens.ts";
import type { PackagePicks, VmWorkerHandle, WorkerSpawnInput } from "./vm-worker.ts";

export type VmPhase = "stopped" | "starting" | "running" | "paused" | "stopping";
/** What a box's thread VM reports to `onPhase`: each change once, in the order stopped, starting, running, stopped. */
export type VmPhaseChange = "stopped" | "starting" | "running";

export interface VmSpec {
  readonly box: BoxRef;
  readonly kind: "thread" | "isolated";
  readonly taskKey: string | null;
  readonly image: string;
  readonly resources: AgentResources;
}

export interface LaunchGrant {
  readonly launchId: string;
  readonly box: BoxRef;
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
  stop(box: BoxRef, taskKey: string | null, launchId?: string): Promise<void>;
  list(): Promise<Array<{ box: BoxRef; taskKey: string | null }>>;
}

export interface AgentRuntime {
  /** Starts the box's VM if needed (one per box; an isolated task of an agent gets its own) and a worker in it. Waits for boot's stopAll. */
  spawn(
    spec: VmSpec,
    worker: WorkerSpawnInput,
    packages: PackagePicks,
  ): Promise<{
    handle: WorkerHandle & VmWorkerHandle;
    layout: VmLayout;
    relayKey: string;
    slot: string;
    launchId: string;
  }>;
  /** A project box's own start (spec boxes): the thread VM and its guest, no worker. Same refusals as `spawn`; the idle timer runs. */
  start(spec: VmSpec): Promise<void>;
  /** A guest operation reached the box: a VM with no worker waits its idle time from now. */
  touch(box: BoxRef): void;
  /** Each change of a box's thread VM, once (a crash or an idle stop included). Returns the way to stop listening. */
  onPhase(listener: (box: BoxRef, phase: VmPhaseChange) => void): () => void;
  phase(box: BoxRef): VmPhase;
  /** The guest link of the box's running thread VM, or undefined: where a project box's operations go. */
  link(box: BoxRef): GuestLink | undefined;
  /** A live worker of the box's running thread VM, or undefined: where a live change of the agent's files goes. */
  threadWorker(box: BoxRef): WorkerHandle | undefined;
  /** Stops every VM of the box (its own and its isolated tasks'). */
  stop(box: BoxRef): Promise<void>;
  /** Boot (spec §8, decision 109 Q4): stop every VM the backend lists, before any spawn runs (RT-42). */
  stopAll(): Promise<void>;
  /** The image tag a launch started with: the gateway's `imageOf` (AVM-P8). */
  imageOf(launchId: string): string | null;
  /** The box is being deleted: a start or a spawn for it answers `not_found` from now on (it stays so; `reopen` is the purge's). */
  close(box: BoxRef): void;
  reopen(box: BoxRef): void;
  /** The owner's Resume: forgets the crashes and lets the agent start VMs again (the persisted pause is the agent store's). */
  resume(box: BoxRef): void;
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
  /** 3 crashes in 10 minutes (RT-40): an agent's existing pause with the reason `crashed` and an Inbox item (AVM-P21). */
  onCrashPause(box: BoxRef): void;
  /** The `boxKey`s of the boxes running when a start was refused for capacity. */
  notifyCapacity(running: string[]): void;
  /** Sub-project 2: the owner's files go into the VM's home once per VM start, as soon as its first worker exists. */
  deliverFiles?(spec: VmSpec, handle: WorkerHandle): Promise<void>;
  /** Every later worker of a VM whose start delivery is settled: it sends what a change missed while no worker was there. */
  deliverAgain?(spec: VmSpec, handle: WorkerHandle): Promise<void>;
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
  /** The delivery of the owner's files into this VM's home; cleared when it failed, so the next worker retries. */
  files: Promise<void> | undefined;
}

/** A function, so a check after an await is not narrowed by the checks before it. */
const isStopping = (entry: { phase: string }): boolean => entry.phase === "stopping";

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const { backend, gateway, tokens, clock, logger } = deps;
  const entries = new Map<string, Entry>();
  const images = new Map<string, string>();
  const paused = new Set<string>();
  const closed = new Set<string>();
  const crashes = createCrashLog(clock);
  const listeners = new Set<(box: BoxRef, phase: VmPhaseChange) => void>();
  const announce = (entry: Entry, phase: VmPhaseChange): void => {
    if (entry.spec.kind !== "thread") return;
    for (const listener of [...listeners]) {
      try {
        listener(entry.spec.box, phase);
      } catch (error) {
        logger.warn("agent_vm_phase_listener_failed", { box: boxKey(entry.spec.box), err: error });
      }
    }
  };
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
    if (spec.kind === "thread") return boxKey(spec.box);
    if (spec.taskKey === null) throw new PapError("bad_request");
    return `${boxKey(spec.box)}\u0000${spec.taskKey}`;
  };
  const isBox = (entry: { spec: VmSpec }, box: BoxRef): boolean => boxKey(entry.spec.box) === boxKey(box);
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
        logger.warn("agent_vm_launch_end_failed", { box: boxKey(entry.spec.box), err: error });
      }
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
      announce(entry, "stopped");
    })();
    return entry.teardown;
  }

  /** Stops by launch, not by key: see `AgentRuntimeBackend.stop`. */
  async function stopLate(entry: Entry): Promise<void> {
    try {
      await backend.stop(entry.spec.box, taskKeyOf(entry.spec), entry.launchId);
    } catch (error) {
      logger.warn("agent_vm_stop_failed", { box: boxKey(entry.spec.box), err: error });
    }
  }

  function onClosed(entry: Entry): void {
    if (isStopping(entry)) return;
    const hadWorkers = entry.idle.live > 0;
    const box = entry.spec.box;
    const key = boxKey(box);
    logger.warn("agent_vm_exited", { box: key, withWorkers: hadWorkers });
    if (hadWorkers && crashes.record(key) && !paused.has(key)) {
      paused.add(key);
      try {
        deps.onCrashPause(box);
      } catch (error) {
        logger.error("agent_vm_crash_pause_failed", { box: key, err: error });
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
      deps.notifyCapacity([...new Set(running.map((e) => boxKey(e.spec.box)))]);
      throw new PapError("capacity");
    }
    const layout = deps.layout(spec); // before the token: a box without a layout leaves nothing behind
    const issued = tokens.issue(spec.box);
    const entry: Entry = {
      key,
      spec,
      launchId: issued.launchId,
      relayKey: issued.relayKey,
      layout,
      idle: createIdleStop(clock, deps.idleMs, () => void tearDown(entry)),
      workers: new Set(),
      phase: "starting",
      link: undefined,
      ready: new Promise<GuestLink>(() => {}), // replaced below, once the entry exists
      teardown: undefined,
      files: undefined,
    };
    entries.set(key, entry);
    announce(entry, "starting");
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
          box: spec.box,
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
        announce(entry, "running");
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

  /** The VM of `spec` once its guest is up, started when it must be; the refusals a spawn and a start share. */
  async function enter(spec: VmSpec): Promise<Entry> {
    const key = keyOf(spec);
    while (boot.state === "pending") await boot.settled;
    if (boot.state === "failed") throw new PapError("worker_failed");
    const refuse = (): void => {
      if (closed.has(boxKey(spec.box))) throw new PapError("not_found");
      if (paused.has(boxKey(spec.box))) throw new PapError("agent_paused");
    };
    refuse();
    let entry = entries.get(key);
    if (entry?.phase === "stopping") {
      await entry.teardown;
      entry = undefined;
      refuse();
    }
    entry ??= entries.get(key) ?? startVm(spec, key);
    await entry.ready;
    if (isStopping(entry)) throw new PapError("worker_failed");
    return entry;
  }

  return {
    async spawn(spec, worker, packages) {
      const entry = await enter(spec);
      const link = await entry.ready;
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
      if (deps.deliverFiles) {
        const deliver = deps.deliverFiles;
        if (entry.files === undefined)
          entry.files = deliver(entry.spec, handle).catch((error: unknown) => {
            entry.files = undefined;
            logger.warn("agent_files_delivery_failed", { box: boxKey(spec.box), err: error });
          });
        else
          void deps.deliverAgain?.(entry.spec, handle).catch((error: unknown) => {
            logger.warn("agent_files_delivery_failed", { box: boxKey(spec.box), err: error });
          });
        // Not awaited: the worker answers only after its `init`, which the launcher sends once this returns (it queues the
        // frames until its session is open). Waiting here would wait for an answer that cannot come.
      }
      return {
        handle,
        layout: entry.layout,
        relayKey: entry.relayKey,
        slot: handle.slot,
        launchId: entry.launchId,
      };
    },
    async start(spec) {
      (await enter(spec)).idle.armIfEmpty();
    },
    touch(box) {
      entries.get(boxKey(box))?.idle.armIfEmpty();
    },
    onPhase(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    link(box) {
      const entry = entries.get(boxKey(box));
      return entry?.phase === "running" ? entry.link : undefined;
    },
    threadWorker(box) {
      const entry = entries.get(boxKey(box));
      if (entry?.phase !== "running") return undefined;
      return entry.workers.values().next().value;
    },
    phase(box) {
      if (paused.has(boxKey(box))) return "paused";
      const mine = [...entries.values()].filter((e) => isBox(e, box));
      return (mine.find((e) => e.spec.kind === "thread") ?? mine[0])?.phase ?? "stopped";
    },
    async stop(box) {
      await Promise.all([...entries.values()].filter((e) => isBox(e, box)).map(tearDown));
    },
    async stopAll() {
      try {
        await Promise.all([...entries.values()].map(tearDown));
        let failed: unknown;
        for (const vm of await backend.list()) {
          try {
            await backend.stop(vm.box, vm.taskKey);
          } catch (error) {
            failed ??= error;
            logger.error("agent_vm_boot_stop_failed", { box: boxKey(vm.box), err: error });
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
    close: (box) => void closed.add(boxKey(box)),
    reopen: (box) => void closed.delete(boxKey(box)),
    resume(box) {
      paused.delete(boxKey(box));
      crashes.clear(boxKey(box));
    },
  };
}
