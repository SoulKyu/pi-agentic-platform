import type { HandlerTable } from "@pap/contracts";
import type { ProjectsService } from "./service.ts";

export type ProjectsRpc = Pick<HandlerTable, "projects.update" | "projects.add">;

export function projectsRpc(service: ProjectsService): ProjectsRpc {
  return {
    "projects.update": async ({ projectId, change }, ctx) => {
      service.update(ctx.caller, projectId, change);
      return { ok: true as const };
    },
    "projects.add": async ({ root }, ctx) => ({ project: service.add(ctx.caller, root) }),
  };
}
