import { type BoxRef, type Caller, type LaunchView, PapError } from "@pap/contracts";
import type { LaunchRegistry } from "../../kernel/launches.ts";
import type { Logger } from "../../kernel/logger.ts";

export interface LaunchStopSource {
  readonly launches: Pick<LaunchRegistry, "live" | "stop">;
  /** The runtime's own stop, never the box control's: that one waits behind the start it would cancel. */
  stopBox(box: BoxRef): Promise<void>;
  readonly logger: Pick<Logger, "warn">;
}

export interface LaunchStop {
  bind(source: LaunchStopSource): void;
  /**
   * Stops the caller's own live launch `id` (another user's, an unknown or an ended one, one outside `stoppable`, and an unbound source are `not_found`).
   * The permission is the box kind's operate: `agents:operate` for an agent, `sessions:operate` for a project. The launch ends
   * as `stopped` first, so the start's rejection that follows the box stop is not its outcome.
   */
  stop(caller: Pick<Caller, "userId" | "permissions">, id: string): Promise<Record<string, never>>;
}

/**
 * R11 (b): Stop never kills sessions that ran on the box before. It is allowed on the `vm` and `guest` steps, and on `worker`
 * only when this launch started the VM (its `vm` step is `done`, not `skipped`). R13 adds that the box has no other VM:
 * the registry asks the runtime (`soleVm`) and publishes the answer as `stoppable`.
 */
export function stoppableSteps(launch: Pick<LaunchView, "steps">): boolean {
  const running = launch.steps.find((step) => step.state === "running");
  if (running === undefined) return false;
  if (running.step === "vm" || running.step === "guest") return true;
  return (
    running.step === "worker" && launch.steps.some((step) => step.step === "vm" && step.state === "done")
  );
}

export function createLaunchStop(): LaunchStop {
  let source: LaunchStopSource | null = null;
  return {
    bind: (next) => void (source = next),
    async stop(caller, id) {
      const launch = source?.launches.live(caller.userId).find((candidate) => candidate.id === id);
      if (source === null || launch === undefined) throw new PapError("not_found");
      if (launch.stoppable !== true) throw new PapError("not_found");
      const permission = launch.box.kind === "agent" ? "agents:operate" : "sessions:operate";
      if (!caller.permissions.has(permission)) throw new PapError("forbidden");
      if (source.launches.stop(id) === null) throw new PapError("not_found");
      try {
        await source.stopBox(launch.box);
      } catch (error) {
        source.logger.warn("launch_stop_failed", { err: error, box: launch.box });
      }
      return {};
    },
  };
}
