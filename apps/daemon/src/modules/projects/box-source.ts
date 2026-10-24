import { AGENT_LIMITS, PapError } from "@pap/contracts";
import type { ProjectBoxSource } from "../../kernel/boxes.ts";
import type { AuditPort } from "../audit/index.ts";
import type { BoxStore } from "./box-store.ts";
import { isCleanPath } from "./limits.ts";

/**
 * What the files, vcs and sessions modules ask of the owner's box projects. `byPath` is lexical (a box path never reaches the
 * host file system): a project's root (its folder in the box, `/boxes/<id>/project`) and what lies below it by whole
 * segments, never `<root>X`, another box's folder, or a path with an empty, `.` or `..` segment.
 */
export function createProjectBoxSource(store: BoxStore, audit?: Pick<AuditPort, "append">): ProjectBoxSource {
  return {
    box(projectId) {
      const record = store.get(projectId);
      return record
        ? {
            ownerId: record.ownerId,
            root: record.root,
            resources: record.resources,
            hosts: record.hosts,
            deleting: record.deleting,
          }
        : null;
    },
    byPath(ownerId, path) {
      if (!isCleanPath(path)) return null;
      const found = store
        .ofOwner(ownerId)
        .find((record) => path === record.root || path.startsWith(`${record.root}/`));
      return found ? { projectId: found.projectId, root: found.root } : null;
    },
    /**
     * Exactly this host, on exactly this project's list (never the owner's, never another project's), audited without the host
     * (the agent chose it). A full list refuses with `limit_reached`, as `network.request` does; a listed host is a no-op.
     */
    addHost(projectId, host, actor) {
      const record = store.get(projectId);
      if (!record || record.hosts.includes(host)) return;
      if (record.hosts.length >= AGENT_LIMITS.hosts) throw new PapError("limit_reached");
      store.set(projectId, { hosts: [...record.hosts, host] });
      audit?.append({
        ownerId: record.ownerId,
        actor: actor.actor,
        ...(actor.actorId === null ? {} : { actorId: actor.actorId }),
        kind: "policy",
        reason: "project_host_added",
        detail: { projectId },
      });
    },
  };
}
