import { ALL_PERMISSIONS, type Caller, type HandlerContext, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { sessionsRpc } from "./rpc.ts";
import type { SessionsService } from "./service.ts";
import { codeOf } from "./testing/helpers.ts";

const caller: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };

function setup(overrides: Partial<SessionsService> = {}) {
  const service: SessionsService = {
    create: vi.fn(async () => ({ sessionId: "p1" })),
    list: vi.fn(() => []),
    prompt: vi.fn(async () => ({ disposition: "started" as const })),
    abort: vi.fn(async () => {}),
    respondDialog: vi.fn(),
    prepareSubscription: vi.fn(async () => {}),
    history: vi.fn(async () => ({ rows: [], hasMore: false, oldestEntryId: null, turnsBefore: 0 })),
    toolOutput: vi.fn(async () => ({ text: "out", truncated: false, isError: false, args: null })),
    branches: vi.fn(async () => ({ leafId: null, points: [] })),
    snapshot: vi.fn(),
    shutdownAll: vi.fn(async () => {}),
    inspect: vi.fn(() => null),
    ...overrides,
  };
  const openSubscription = vi.fn(() => "s1");
  const ctx: HandlerContext = { caller, connectionId: "c1", openSubscription, closeSubscription: vi.fn() };
  return { rpc: sessionsRpc(service), service, ctx, openSubscription };
}

describe("sessions rpc", () => {
  it("hands each call to one service method with the caller", async () => {
    const { rpc, service, ctx } = setup();
    expect(await rpc["sessions.create"]({ cwd: "/w" }, ctx)).toEqual({ sessionId: "p1" });
    expect(service.create).toHaveBeenCalledWith("/w", caller);
    expect(await rpc["sessions.list"]({}, ctx)).toEqual({ sessions: [] });
    expect(
      await rpc["sessions.prompt"]({ sessionId: "p1", text: "hi", streamingBehavior: "steer" }, ctx),
    ).toEqual({
      disposition: "started",
    });
    expect(service.prompt).toHaveBeenCalledWith(
      { sessionId: "p1", text: "hi", streamingBehavior: "steer" },
      caller,
    );
    expect(await rpc["sessions.abort"]({ sessionId: "p1" }, ctx)).toEqual({ ok: true });
    expect(
      await rpc["sessions.respondDialog"](
        { sessionId: "p1", dialogId: "d1", response: { confirmed: true } },
        ctx,
      ),
    ).toEqual({
      ok: true,
    });
    expect(service.respondDialog).toHaveBeenCalledWith(
      { sessionId: "p1", dialogId: "d1", response: { confirmed: true } },
      caller,
    );
  });

  it("hands each read to one service method with the caller", async () => {
    const { rpc, service, ctx } = setup();
    const params = { sessionId: "p1", before: "e4", limit: 20 };
    expect(await rpc["sessions.history"](params, ctx)).toEqual({
      rows: [],
      hasMore: false,
      oldestEntryId: null,
      turnsBefore: 0,
    });
    expect(service.history).toHaveBeenCalledWith(params, caller);
    expect(await rpc["sessions.toolOutput"]({ sessionId: "p1", toolCallId: "c1" }, ctx)).toMatchObject({
      text: "out",
    });
    expect(service.toolOutput).toHaveBeenCalledWith({ sessionId: "p1", toolCallId: "c1" }, caller);
    expect(await rpc["sessions.branches"]({ sessionId: "p1" }, ctx)).toEqual({ leafId: null, points: [] });
    expect(service.branches).toHaveBeenCalledWith("p1", caller);
  });

  it("lets not_found through from a read", async () => {
    const { rpc, ctx } = setup({
      history: vi.fn(async () => {
        throw new PapError("not_found");
      }),
    });
    expect(await codeOf(rpc["sessions.history"]({ sessionId: "p1", before: "e1" }, ctx))).toBe("not_found");
  });

  it("opens a subscription only for a session the caller may read", async () => {
    const { rpc, ctx, openSubscription } = setup();
    expect(await rpc["subscribe.session"]({ sessionId: "p1", after: { epoch: "e", seq: 4 } }, ctx)).toEqual({
      sub: "s1",
    });
    expect(openSubscription).toHaveBeenCalledWith("session", "p1", { epoch: "e", seq: 4 });
    const refused = setup({
      prepareSubscription: vi.fn(async () => {
        throw new PapError("not_found");
      }),
    });
    expect(await codeOf(refused.rpc["subscribe.session"]({ sessionId: "p1" }, refused.ctx))).toBe(
      "not_found",
    );
    expect(refused.openSubscription).not.toHaveBeenCalled();
  });

  it("opens the subscription only after the read has been prepared (R108)", async () => {
    const order: string[] = [];
    let prepared: () => void = () => {};
    const { rpc, ctx, openSubscription } = setup({
      prepareSubscription: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            prepared = () => {
              order.push("prepared");
              resolve();
            };
          }),
      ),
    });
    openSubscription.mockImplementation(() => {
      order.push("opened");
      return "s1";
    });
    const pending = rpc["subscribe.session"]({ sessionId: "p1" }, ctx);
    await Promise.resolve();
    expect(openSubscription).not.toHaveBeenCalled();
    prepared();
    await pending;
    expect(order).toEqual(["prepared", "opened"]);
  });

  it("lets a typed error through for the dispatcher to map", async () => {
    const { rpc, ctx } = setup({
      create: vi.fn(async () => {
        throw new PapError("capacity");
      }),
    });
    expect(await codeOf(rpc["sessions.create"]({ cwd: "/w" }, ctx))).toBe("capacity");
  });
});
