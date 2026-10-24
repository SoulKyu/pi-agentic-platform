import type { HandlerTable } from "@pap/contracts";
import type { GithubActionsService } from "./actions.ts";
import type { GithubProjectsService } from "./projects.ts";

export type GithubProjectsRpc = Pick<
  HandlerTable,
  | "github.repositories"
  | "projects.createFromGithub"
  | "projects.linkGithub"
  | "projects.unlinkGithub"
  | "projects.cloneAgain"
  | "projects.commitPush"
  | "projects.prCreate"
  | "projects.github"
  | "projects.checkLog"
  | "projects.sendToSession"
>;

/** Each handler makes one service call and lets typed errors through. */
export function githubProjectsRpc(
  service: GithubProjectsService,
  actions: GithubActionsService,
): GithubProjectsRpc {
  return {
    "github.repositories": async ({ query }, ctx) => service.repositories(ctx.caller, query),
    "projects.createFromGithub": async (params, ctx) => service.createFromGithub(ctx.caller, params),
    "projects.linkGithub": async (params, ctx) => ({ github: await service.linkGithub(ctx.caller, params) }),
    "projects.unlinkGithub": async ({ projectId }, ctx) => {
      await service.unlinkGithub(ctx.caller, projectId);
      return { ok: true };
    },
    "projects.cloneAgain": async ({ projectId }, ctx) => {
      await service.cloneAgain(ctx.caller, projectId);
      return { ok: true };
    },
    "projects.commitPush": async (params, ctx) => actions.commitPush(ctx.caller, params),
    "projects.prCreate": async (params, ctx) => actions.prCreate(ctx.caller, params),
    "projects.github": async ({ projectId }, ctx) => ({
      github: await actions.github(ctx.caller, projectId),
    }),
    "projects.checkLog": async (params, ctx) => actions.checkLog(ctx.caller, params),
    "projects.sendToSession": async (params, ctx) => actions.sendToSession(ctx.caller, params),
  };
}
