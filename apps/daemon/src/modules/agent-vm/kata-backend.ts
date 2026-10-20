import { VmStartResult } from "@pap/contracts";
import { z } from "zod";
import type { Logger } from "../../kernel/logger.ts";
import type { KataImages } from "./kata-images.ts";
import type { AgentRuntimeBackend, VmSpec } from "./runtime.ts";
import { papErrorOf, type VmdClient, VmdError } from "./vmd-client.ts";

export const GROW_NOTICE =
  "Le disque de cet agent grandira au prochain démarrage, quand plus aucune de ses VM ne tourne.";

const Listing = z.object({
  vms: z.array(z.object({ agentId: z.string(), taskKey: z.string().nullable() }).loose()),
});

export interface KataBackendDeps {
  readonly client: VmdClient;
  /** Told which image the agent's thread VM runs on (the policy's `running`). */
  readonly images: Pick<KataImages, "started" | "stopped">;
  readonly logger: Logger;
  /** Posts once into the agent's thread. */
  readonly notice: (agentId: string, text: string) => void;
}

const keyOf = (agentId: string, taskKey: string | null): string =>
  taskKey === null ? agentId : `${agentId}\u0000${taskKey}`;

/**
 * The runtime's backend over pap-vmd (R3, R30, R31). Starts and stops of one VM are served in order, and a stop names its launch:
 * one for a launch that is no longer the VM's is ignored, so a late stop never reaches a fresh VM of the same key (AVM-E46).
 * An isolated task's VM is `vm.start`/`vm.stop` only: its disk is pap-vmd's own, and no `disk.*` op is ever sent for it.
 */
export function createKataBackend(deps: KataBackendDeps): AgentRuntimeBackend {
  const { client, logger } = deps;
  /** The agent's disk size in MiB, once this daemon has seen it made or grown. */
  const disks = new Map<string, number>();
  /** The launch each key's VM was last started for. */
  const current = new Map<string, string>();
  const tails = new Map<string, Promise<unknown>>();

  function inOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  }

  /** `disk.create` the first time, `disk.grow` when the profile asks for more; a grow under a running VM waits for the next start. */
  async function ensureDisk(spec: VmSpec): Promise<void> {
    const { agentId } = spec;
    const wanted = spec.resources.diskMb;
    const known = disks.get(agentId);
    if (known === undefined) {
      try {
        await client.request({ op: "disk.create", agentId, taskKey: null, diskMb: wanted });
        disks.set(agentId, wanted);
        return;
      } catch (error) {
        // The disk exists (an earlier run, or a restart of this daemon): its size is read through the grow below.
        if (!(error instanceof VmdError && error.code === "conflict")) throw error;
      }
    } else if (known >= wanted) return;
    try {
      await client.request({ op: "disk.grow", agentId, taskKey: null, diskMb: wanted });
    } catch (error) {
      if (error instanceof VmdError && error.code === "conflict") {
        // Only a growth that was asked for: after a restart the size is not known, and nothing says it changed.
        if (known !== undefined) deps.notice(agentId, GROW_NOTICE);
        return;
      }
      // pap-vmd never shrinks a file: the disk is larger than the profile says, which is fine.
      if (!(error instanceof VmdError && error.code === "bad_request")) throw error;
      logger.info("agent_disk_larger_than_profile", { agentId });
    }
    disks.set(agentId, wanted);
  }

  return {
    start(spec, launch) {
      const key = keyOf(spec.agentId, spec.taskKey);
      return inOrder(key, async () => {
        current.set(key, launch.launchId);
        try {
          if (spec.kind === "thread") await ensureDisk(spec);
          const started = VmStartResult.safeParse(
            await client.request({
              op: "vm.start",
              agentId: spec.agentId,
              kind: spec.kind,
              taskKey: spec.taskKey,
              image: spec.image,
              resources: spec.resources,
              launchId: launch.launchId,
              token: launch.token,
            }),
          );
          if (!started.success) throw new VmdError("protocol");
          if (spec.kind === "thread") deps.images.started(spec.agentId, spec.image);
          return { address: started.data.address };
        } catch (error) {
          // `current` stays this launch's: the runtime's cleanup stop for it must go out, whatever pap-vmd made before it failed.
          // pap-vmd has no such disk any more (deleted elsewhere): what was known of it is stale.
          if (error instanceof VmdError && error.code === "not_found") disks.delete(spec.agentId);
          throw papErrorOf(error);
        }
      });
    },

    stop(agentId, taskKey, launchId) {
      const key = keyOf(agentId, taskKey);
      return inOrder(key, async () => {
        if (launchId !== undefined && current.get(key) !== launchId) {
          logger.info("agent_vm_stop_ignored", { agentId });
          return;
        }
        try {
          await client.request({ op: "vm.stop", agentId, taskKey });
        } catch (error) {
          throw papErrorOf(error);
        }
        current.delete(key);
        if (taskKey === null) deps.images.stopped(agentId);
      });
    },

    async list() {
      try {
        const listed = Listing.safeParse(await client.request({ op: "vm.list" }));
        if (!listed.success) throw new VmdError("protocol");
        return listed.data.vms.map(({ agentId, taskKey }) => ({ agentId, taskKey }));
      } catch (error) {
        throw papErrorOf(error);
      }
    },
  };
}
