import { PapError } from "@pap/contracts";
import type { BoxTerminals } from "../../kernel/boxes.ts";
import type { AgentRuntime } from "./runtime.ts";

/**
 * The daemon's end of the box terminals (lot B2). Like the guest ops, an open never starts the VM: a box that is not running
 * answers `box_stopped` (the terminal service starts it first, as an explicit action).
 */
export function createBoxTerminals(runtime: Pick<AgentRuntime, "phase" | "link" | "touch">): BoxTerminals {
  const boxOf = (projectId: string) => ({ kind: "project", id: projectId }) as const;
  return {
    open(projectId, input) {
      const box = boxOf(projectId);
      const link = runtime.phase(box) === "running" ? runtime.link(box) : undefined;
      if (link === undefined) return Promise.reject(new PapError("box_stopped"));
      runtime.touch(box);
      return link.openTerminal(input);
    },
    touch: (projectId) => runtime.touch(boxOf(projectId)),
  };
}
