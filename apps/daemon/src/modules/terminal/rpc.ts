import type { HandlerTable } from "@pap/contracts";
import type { TerminalService } from "./service.ts";

export type TerminalRpc = Pick<
  HandlerTable,
  | "subscribe.terminal"
  | "terminal.create"
  | "terminal.attach"
  | "terminal.detach"
  | "terminal.resize"
  | "terminal.close"
>;

export function terminalRpc(service: TerminalService): TerminalRpc {
  return {
    // The stream is the caller's own: its key is the owner, like `shell` (M8R65).
    "subscribe.terminal": async ({ after }, ctx) => ({
      sub: ctx.openSubscription("terminal", ctx.caller.userId, after),
    }),
    "terminal.create": async (params, ctx) => ({ terminalId: await service.create(ctx.caller, params) }),
    "terminal.attach": async (params, ctx) =>
      service.attach(ctx.caller, ctx.connectionId, ctx.binary, params),
    "terminal.detach": async ({ streamId }, ctx) => {
      service.detach(ctx.caller, ctx.connectionId, streamId);
      return { ok: true as const };
    },
    "terminal.resize": async (params, ctx) => {
      service.resize(ctx.caller, params);
      return { ok: true as const };
    },
    "terminal.close": async ({ terminalId }, ctx) => {
      await service.close(ctx.caller, terminalId);
      return { ok: true as const };
    },
  };
}
