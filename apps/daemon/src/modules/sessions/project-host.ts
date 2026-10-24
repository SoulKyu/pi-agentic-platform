import { AGENT_LIMITS, AgentHostEntry, type Caller } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import { hostLabel } from "../egress/index.ts";
import type { SessionBoxes } from "./project-gate.ts";

/**
 * The owner's "Allow this host" on a session in a project's box (spec boxes, task A7): the host joins that project's list only,
 * audited by the source's `addHost`. Returns whether the host is on the list now (a duplicate is not an error); false when the
 * entry rule refuses it or the list is full. The agent chose the host, so the log shows it as a hash and a length.
 */
export function allowProjectHost(
  deps: { readonly boxes: SessionBoxes; readonly logger: Logger },
  projectId: string,
  host: string,
  caller: Pick<Caller, "userId">,
): boolean {
  const label = hostLabel(host, new Set());
  if (!AgentHostEntry.safeParse(host).success) {
    deps.logger.warn("project_host_invalid", { projectId, host: label });
    return false;
  }
  const listed = deps.boxes.box(projectId)?.hosts ?? [];
  if (!listed.includes(host)) {
    if (listed.length >= AGENT_LIMITS.hosts) {
      deps.logger.warn("project_host_limit", { projectId, limit: AGENT_LIMITS.hosts });
      return false;
    }
    deps.boxes.addHost(projectId, host, { actor: "user", actorId: caller.userId });
    deps.logger.info("project_host_added", { projectId, host: label });
  }
  return true;
}
