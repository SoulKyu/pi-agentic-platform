import type { HandlerTable } from "@pap/contracts";
import type { SessionsService } from "./service.ts";

export type SessionsRpc = Pick<
  HandlerTable,
  | "sessions.create"
  | "sessions.list"
  | "sessions.prompt"
  | "sessions.abort"
  | "sessions.navigate"
  | "sessions.compact"
  | "sessions.rename"
  | "sessions.autoName"
  | "sessions.exportHtml"
  | "sessions.models"
  | "sessions.commands"
  | "sessions.setModel"
  | "sessions.setThinking"
  | "sessions.setTools"
  | "sessions.fork"
  | "sessions.clone"
  | "sessions.clearQueue"
  | "sessions.respondDialog"
  | "sessions.panelInput"
  | "sessions.history"
  | "sessions.toolOutput"
  | "sessions.branches"
  | "subscribe.session"
>;

export function sessionsRpc(service: SessionsService): SessionsRpc {
  return {
    "sessions.create": async ({ cwd, preset }, ctx) => service.create(cwd, ctx.caller, preset),
    "sessions.list": async (_params, ctx) => {
      const { sessions, truncated } = service.listFitted(ctx.caller);
      return { sessions, ...(truncated ? { truncated: true as const } : {}) };
    },
    "sessions.prompt": async (params, ctx) => service.prompt(params, ctx.caller),
    "sessions.abort": async ({ sessionId }, ctx) => {
      await service.abort(sessionId, ctx.caller);
      return { ok: true as const };
    },
    "sessions.navigate": async (params, ctx) => service.navigate(params, ctx.caller),
    "sessions.compact": async (params, ctx) => service.compact(params, ctx.caller),
    "sessions.rename": async (params, ctx) => {
      await service.rename(params, ctx.caller);
      return { ok: true as const };
    },
    "sessions.autoName": async ({ sessionId }, ctx) => service.autoName(sessionId, ctx.caller),
    "sessions.exportHtml": async ({ sessionId }, ctx) => service.exportHtml(sessionId, ctx.caller),
    "sessions.models": async ({ sessionId }, ctx) => service.models(sessionId, ctx.caller),
    "sessions.commands": async ({ sessionId }, ctx) => service.commands(sessionId, ctx.caller),
    "sessions.setModel": async (params, ctx) => {
      await service.setModel(params, ctx.caller);
      return { ok: true as const };
    },
    "sessions.setThinking": async (params, ctx) => {
      await service.setThinking(params, ctx.caller);
      return { ok: true as const };
    },
    "sessions.setTools": async (params, ctx) => {
      await service.setTools(params, ctx.caller);
      return { ok: true as const };
    },
    "sessions.fork": async (params, ctx) => service.fork(params, ctx.caller),
    "sessions.clone": async ({ sessionId }, ctx) => service.clone({ sessionId }, ctx.caller),
    "sessions.clearQueue": async ({ sessionId }, ctx) => service.clearQueue(sessionId, ctx.caller),
    "sessions.respondDialog": async (params, ctx) => {
      service.respondDialog(params, ctx.caller);
      return { ok: true as const };
    },
    "sessions.panelInput": async (params, ctx) => {
      service.panelInput(params, ctx.caller);
      return { ok: true as const };
    },
    "sessions.history": async (params, ctx) => service.history(params, ctx.caller),
    "sessions.toolOutput": async (params, ctx) => service.toolOutput(params, ctx.caller),
    "sessions.branches": async ({ sessionId }, ctx) => service.branches(sessionId, ctx.caller),
    // Opening a subscription is this handler's only effect. A handler that also had a side effect would open the
    // subscription first: it can fail with capacity or not_found, and failing after the effect would invite a retry
    // of the same command (R79). What is awaited first is the read's preparation: the owner check and the transcript
    // reader the hub's synchronous snapshot provider needs (R108).
    "subscribe.session": async ({ sessionId, after }, ctx) => {
      const from = await service.prepareSubscription(sessionId, ctx.caller, after);
      return { sub: ctx.openSubscription("session", sessionId, from) };
    },
  };
}
