import { AgentId, TaskKey } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import { processRootOf } from "./layouts.ts";
import { type VmdClient, VmdError } from "./vmd-client.ts";

export interface KeptForgetDeps {
  /** pap-vmd; null under the process backend, whose kept folder is a process root. */
  readonly client: VmdClient | null;
  readonly papHome: string;
  readonly logger: Pick<Logger, "warn">;
  /** Removes a process root (the agents module's `removeTree`: the image folder in it is read-only). */
  readonly remove: (path: string) => void;
}

/**
 * Forgets a trigger's kept folder (K2): pap-vmd deletes `kept/<keepKey>/`, the process backend removes its process root.
 * Answers `busy` when pap-vmd says a live VM holds the disk (`conflict`) or fails (unreachable, an error): the caller tries
 * again later. Else `done`. Best effort: a failure is logged and never thrown, a missing disk is no failure.
 */
export function createKeptForget(deps: KeptForgetDeps) {
  return async (agentId: string, keepKey: string): Promise<"done" | "busy"> => {
    try {
      if (!AgentId.safeParse(agentId).success || !TaskKey.safeParse(keepKey).success) return "done";
      if (deps.client === null) {
        deps.remove(processRootOf(deps.papHome, { agentId, taskKey: keepKey }));
        return "done";
      }
      await deps.client.request({
        op: "disk.delete",
        box: { kind: "agent", id: agentId },
        taskKey: null,
        keepKey,
        purge: true,
      });
    } catch (error) {
      if (error instanceof VmdError && error.code === "conflict") return "busy";
      if (error instanceof VmdError && error.code === "not_found") return "done";
      // pap-vmd unreachable or failing: the caller tries again later, like a held disk.
      deps.logger.warn("kept_folder_forget_failed", { err: error });
      return "busy";
    }
    return "done";
  };
}
