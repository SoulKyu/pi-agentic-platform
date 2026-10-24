import type { HandlerTable } from "@pap/contracts";
import type { ProjectsService } from "./service.ts";

export type ProjectsRpc = Pick<
  HandlerTable,
  | "projects.update"
  | "projects.add"
  | "projects.knowledge"
  | "projects.enableKnowledge"
  | "projects.create"
  | "projects.scratch"
  | "projects.delete"
  | "projects.box"
  | "projects.setBox"
  | "projects.startBox"
  | "projects.restartBox"
  | "projects.rebuild"
>;

export function projectsRpc(service: ProjectsService): ProjectsRpc {
  return {
    "projects.update": async ({ projectId, change }, ctx) => {
      service.update(ctx.caller, projectId, change);
      return { ok: true as const };
    },
    "projects.knowledge": async ({ projectId, sessionId }, ctx) =>
      service.knowledge(ctx.caller, projectId, sessionId),
    "projects.enableKnowledge": async ({ projectId, sessionId }, ctx) =>
      service.enableKnowledge(ctx.caller, projectId, sessionId),
    "projects.add": async ({ root }, ctx) => ({ project: service.add(ctx.caller, root) }),
    "projects.create": async ({ name }, ctx) => ({ project: service.create(ctx.caller, name) }),
    "projects.scratch": async (_params, ctx) => ({ project: service.scratch(ctx.caller) }),
    "projects.delete": async ({ projectId }, ctx) => service.remove(ctx.caller, projectId),
    "projects.box": async ({ projectId }, ctx) => ({ box: service.box(ctx.caller, projectId) }),
    "projects.setBox": async (params, ctx) => ({ box: service.setBox(ctx.caller, params) }),
    "projects.startBox": async ({ projectId }, ctx) => service.startBox(ctx.caller, projectId),
    "projects.restartBox": async ({ projectId }, ctx) => service.restartBox(ctx.caller, projectId),
    "projects.rebuild": async ({ projectId }, ctx) => service.rebuild(ctx.caller, projectId),
  };
}
