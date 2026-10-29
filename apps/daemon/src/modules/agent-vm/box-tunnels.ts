import { PapError } from "@pap/contracts";
import type { BoxTunnels } from "../../kernel/boxes.ts";
import type { AgentRuntime } from "./runtime.ts";

/**
 * The daemon's end of the tunnels to a box's preview services (UX-2 §6). Like the guest ops, an open never starts the VM: a
 * box that is not running answers `box_stopped`. It never touches the box either: the previews module decides what counts as
 * activity (a service alone never keeps a box awake).
 */
export function createBoxTunnels(runtime: Pick<AgentRuntime, "phase" | "link">): BoxTunnels {
  return {
    open(box, serviceId) {
      const link = runtime.phase(box) === "running" ? runtime.link(box) : undefined;
      if (link === undefined) return Promise.reject(new PapError("box_stopped"));
      return link.openTunnel({ service: serviceId });
    },
  };
}
