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
    listFitted: vi.fn(() => ({ sessions: [], truncated: false })),
    shellSnapshot: vi.fn(),
    listArchived: vi.fn(() => ({ sessions: [], hasMore: false })),
    summary: vi.fn(() => null),
    prompt: vi.fn(async () => ({ disposition: "started" as const })),
    abort: vi.fn(async () => {}),
    navigate: vi.fn(async () => ({ cancelled: false, editorText: "q" })),
    compact: vi.fn(async () => ({ tokensBefore: 9, estimatedTokensAfter: null })),
    rename: vi.fn(async () => {}),
    autoName: vi.fn(async () => ({ name: "Fix login" })),
    exportHtml: vi.fn(async () => ({ url: `/api/sessions/p1/export/${"A".repeat(43)}` })),
    fork: vi.fn(async () => ({ sessionId: "p2", text: "q1" })),
    clone: vi.fn(async () => ({ sessionId: "p3" })),
    clearQueue: vi.fn(async () => ({ steering: ["a"], followUp: [], truncated: false })),
    respondDialog: vi.fn(),
    panelInput: vi.fn(),
    prepareSubscription: vi.fn(async () => {}),
    history: vi.fn(async () => ({ rows: [], hasMore: false, oldestEntryId: null, turnsBefore: 0 })),
    toolOutput: vi.fn(async () => ({ text: "out", truncated: false, isError: false, args: null })),
    branches: vi.fn(async () => ({ leafId: null, points: [], truncated: false })),
    snapshot: vi.fn(),
    shutdownAll: vi.fn(async () => {}),
    inspect: vi.fn(() => null),
    backfillProjects: vi.fn(() => 0),
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
    expect(await rpc["sessions.fork"]({ sessionId: "p1", entryId: "u1" }, ctx)).toEqual({
      sessionId: "p2",
      text: "q1",
    });
    expect(service.fork).toHaveBeenCalledWith({ sessionId: "p1", entryId: "u1" }, caller);
    expect(await rpc["sessions.clone"]({ sessionId: "p1" }, ctx)).toEqual({ sessionId: "p3" });
    expect(service.clone).toHaveBeenCalledWith({ sessionId: "p1" }, caller);
    expect(await rpc["sessions.clearQueue"]({ sessionId: "p1" }, ctx)).toEqual({
      steering: ["a"],
      followUp: [],
      truncated: false,
    });
    expect(service.clearQueue).toHaveBeenCalledWith("p1", caller);
    expect(await rpc["sessions.navigate"]({ sessionId: "p1", targetId: "u0" }, ctx)).toEqual({
      cancelled: false,
      editorText: "q",
    });
    expect(service.navigate).toHaveBeenCalledWith({ sessionId: "p1", targetId: "u0" }, caller);
    expect(await rpc["sessions.compact"]({ sessionId: "p1", customInstructions: "short" }, ctx)).toEqual({
      tokensBefore: 9,
      estimatedTokensAfter: null,
    });
    expect(service.compact).toHaveBeenCalledWith({ sessionId: "p1", customInstructions: "short" }, caller);
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

  it("hands rename and autoName to one service method each", async () => {
    const { rpc, service, ctx } = setup();
    expect(await rpc["sessions.rename"]({ sessionId: "p1", name: "Fix" }, ctx)).toEqual({ ok: true });
    expect(service.rename).toHaveBeenCalledWith({ sessionId: "p1", name: "Fix" }, caller);
    expect(await rpc["sessions.autoName"]({ sessionId: "p1" }, ctx)).toEqual({ name: "Fix login" });
    expect(service.autoName).toHaveBeenCalledWith("p1", caller);
  });

  it("hands exportHtml to one service method", async () => {
    const { rpc, service, ctx } = setup();
    expect(await rpc["sessions.exportHtml"]({ sessionId: "p1" }, ctx)).toEqual({
      url: `/api/sessions/p1/export/${"A".repeat(43)}`,
    });
    expect(service.exportHtml).toHaveBeenCalledWith("p1", caller);
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
    expect(await rpc["sessions.branches"]({ sessionId: "p1" }, ctx)).toEqual({
      leafId: null,
      points: [],
      truncated: false,
    });
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

  it("hands a panel keystroke to the service and lets not_found through", async () => {
    const { rpc, service, ctx } = setup();
    expect(await rpc["sessions.panelInput"]({ sessionId: "p1", panelId: "pn1", data: "\r" }, ctx)).toEqual({
      ok: true,
    });
    expect(service.panelInput).toHaveBeenCalledWith({ sessionId: "p1", panelId: "pn1", data: "\r" }, caller);
    const refused = setup({
      panelInput: vi.fn(() => {
        throw new PapError("not_found");
      }),
    });
    expect(
      await codeOf(
        refused.rpc["sessions.panelInput"]({ sessionId: "p1", panelId: "x", data: "k" }, refused.ctx),
      ),
    ).toBe("not_found");
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
