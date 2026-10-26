import { boxKey, PapError, type VmLayout } from "@pap/contracts";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";
import type { GuestLink } from "./guest-link.ts";
import { createIdleStop, fitsCapacity, type IdleStop, KEPT_IDLE_MS } from "./lifecycle.ts";
import type { AgentRuntimeDeps, VmPhaseChange, VmSpec } from "./runtime.ts";
import type { VmWorkerHandle } from "./vm-worker.ts";

export interface Entry {
  readonly key: string;
  readonly spec: VmSpec;
  readonly launchId: string;
  readonly relayKey: string;
  readonly layout: VmLayout;
  readonly idle: IdleStop;
  readonly workers: Set<VmWorkerHandle>;
  /** Aborted by the teardown: a pending wait for the guest ends at once. */
  readonly abort: AbortController;
  phase: "starting" | "running" | "stopping";
  link: GuestLink | undefined;
  ready: Promise<GuestLink>;
  teardown: Promise<void> | undefined;
  /** The delivery of the owner's files into this VM's home; cleared when it failed, so the next worker retries. */
  files: Promise<void> | undefined;
}

/** A function, so a check after an await is not narrowed by the checks before it. */
/** What a start that was cut short rejects with: `stopped` when the person stopped its launch, else `worker_failed`. */
export const cutShort = (spec: { readonly launch?: { stopped(): boolean } | undefined }): PapError =>
  new PapError(spec.launch?.stopped() ? "stopped" : "worker_failed");

export const isStopping = (entry: { phase: string }): boolean => entry.phase === "stopping";

export interface VmStarterContext {
  readonly deps: AgentRuntimeDeps;
  readonly entries: Map<string, Entry>;
  readonly images: Map<string, string>;
  readonly announce: (entry: Entry, phase: VmPhaseChange) => void;
  readonly tearDown: (entry: Entry) => Promise<void>;
  readonly stopLate: (entry: Entry) => Promise<void>;
  readonly onClosed: (entry: Entry) => void;
  readonly taskKeyOf: (spec: VmSpec) => string | null;
}

export function createVmStarter(context: VmStarterContext) {
  const { deps, entries, images, announce, tearDown, stopLate, onClosed, taskKeyOf } = context;
  const { backend, gateway, tokens, clock } = deps;

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
      const used = running.reduce((sum, e) => sum + e.spec.resources.memoryMb + VM_OVERHEAD_MB, 0);
      throw new PapError("capacity", { memory: { used, max: deps.memoryCapMb } });
    }
    const layout = deps.layout(spec); // before the token: a box without a layout leaves nothing behind
    const issued = tokens.issue(spec.box);
    const entry: Entry = {
      key,
      spec,
      launchId: issued.launchId,
      relayKey: issued.relayKey,
      layout,
      idle: createIdleStop(
        clock,
        spec.kind === "isolated" && spec.keepKey ? KEPT_IDLE_MS : deps.idleMs,
        () => void tearDown(entry),
      ),
      workers: new Set(),
      abort: new AbortController(),
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
        const { address } = await backend.start(
          spec,
          { launchId: entry.launchId, token: issued.token },
          spec.launch,
        );
        if (isStopping(entry)) {
          // A stop arrived while the VM was starting: its teardown ran before the VM existed, so stop it now.
          await stopLate(entry);
          throw cutShort(spec);
        }
        deps.onLaunch({
          launchId: entry.launchId,
          box: spec.box,
          relayKey: issued.relayKey,
          address,
          taskKey: taskKeyOf(spec),
        });
        spec.launch?.step("guest", "running");
        const link = await gateway.awaitGuest(entry.launchId, entry.abort.signal).catch((error: unknown) => {
          spec.launch?.step("guest", "failed");
          throw error;
        });
        spec.launch?.step("guest", "done");
        if (isStopping(entry)) {
          link.shutdown();
          await stopLate(entry);
          throw cutShort(spec);
        }
        entry.link = link;
        entry.phase = "running";
        announce(entry, "running");
        void link.closed.then(() => onClosed(entry));
        return link;
      } catch (error) {
        await tearDown(entry);
        throw spec.launch?.stopped() ? cutShort(spec) : error;
      }
    })();
    entry.ready.catch(() => {});
    return entry;
  }

  return startVm;
}
