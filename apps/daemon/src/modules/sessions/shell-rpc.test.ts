import type { HandlerContext } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import type { SessionsService } from "./service.ts";
import { shellRpc } from "./shell-rpc.ts";

function setup() {
  const listArchived = vi.fn(() => ({ sessions: [], hasMore: false }));
  const service = { listArchived } as unknown as SessionsService;
  const openSubscription = vi.fn(() => "s7");
  const ctx: HandlerContext = {
    caller: testCaller({ userId: "u9" }),
    connectionId: "c1",
    openSubscription,
    closeSubscription: vi.fn(),
  };
  return { rpc: shellRpc(service), ctx, openSubscription, listArchived };
}

describe("shell rpc", () => {
  it("opens the caller's own shell stream, with or without a cursor", async () => {
    const { rpc, ctx, openSubscription } = setup();
    expect(await rpc["subscribe.shell"]({}, ctx)).toEqual({ sub: "s7" });
    expect(openSubscription).toHaveBeenLastCalledWith("shell", "u9", undefined);
    const after = { epoch: "e1", seq: 4 };
    await rpc["subscribe.shell"]({ after }, ctx);
    expect(openSubscription).toHaveBeenLastCalledWith("shell", "u9", after);
  });

  it("passes the caller and the params to listArchived", async () => {
    const { rpc, ctx, listArchived } = setup();
    const params = { before: { archivedAt: 5, id: "x" }, limit: 10 };
    expect(await rpc["sessions.listArchived"](params, ctx)).toEqual({ sessions: [], hasMore: false });
    expect(listArchived).toHaveBeenCalledWith(ctx.caller, params);
  });
});
