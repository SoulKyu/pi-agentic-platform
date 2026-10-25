import type { HandlerContext, HandlerTable } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ReceiptStore } from "../db/receipts.ts";
import { silentLogger } from "../logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createDispatcher } from "./dispatcher.ts";
import { NO_CLIENT_PATHS } from "./client-path-gate.ts";

const VALUE = `pap_${"Zq".repeat(21)}Z`;
const TOKEN_VIEW = {
  id: "tok-1",
  name: "ci",
  hint: VALUE.slice(-4),
  permissions: ["sessions:read" as const],
  createdAt: 1,
  expiresAt: 2,
  lastUsedAt: null,
};
const PARAMS = { name: "ci", permissions: ["sessions:read"], expiresInDays: 7 };
const ctx: HandlerContext = {
  caller: testCaller(),
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
};

function dispatcherBed(handler: () => Promise<unknown>) {
  const stored = new Map<string, { method: string; result: unknown }>();
  const receipts: ReceiptStore = {
    find: (userId, commandId) => stored.get(`${userId}:${commandId}`) ?? null,
    save: (userId, commandId, method, result) =>
      void stored.set(`${userId}:${commandId}`, { method, result }),
    purge: () => 0,
    readOnly: false,
  };
  const spy = vi.fn(handler);
  const handlers = { "auth.tokens.create": spy } as unknown as HandlerTable;
  return {
    dispatch: createDispatcher({ gate: NO_CLIENT_PATHS, handlers, receipts, logger: silentLogger }),
    dump: () => [...stored.values()],
    spy,
  };
}
const frame = { id: 1, method: "auth.tokens.create", params: PARAMS, commandId: "cmd-00000001" };

describe("dispatcher secret receipts (M5R68)", () => {
  it("keeps no result for a secret method and answers a replay with conflict", async () => {
    const { dispatch, dump, spy } = dispatcherBed(async () => ({ token: TOKEN_VIEW, value: VALUE }));
    expect(await dispatch(frame, ctx)).toEqual({
      id: 1,
      ok: true,
      result: { token: TOKEN_VIEW, value: VALUE },
    });
    expect(JSON.stringify(dump())).not.toContain(VALUE);
    expect(dump()).toHaveLength(1);
    expect(await dispatch({ ...frame, id: 2 }, ctx)).toEqual({
      id: 2,
      ok: false,
      error: { code: "conflict" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps bad_request for the same commandId with another request", async () => {
    const { dispatch } = dispatcherBed(async () => ({ token: TOKEN_VIEW, value: VALUE }));
    await dispatch(frame, ctx);
    const other = { ...frame, id: 3, params: { ...PARAMS, name: "other" } };
    expect(await dispatch(other, ctx)).toEqual({ id: 3, ok: false, error: { code: "bad_request" } });
  });

  it("shares the first answer with a duplicate still in flight, once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { dispatch, spy } = dispatcherBed(async () => {
      await gate;
      return { token: TOKEN_VIEW, value: VALUE };
    });
    const first = dispatch(frame, ctx);
    const second = dispatch({ ...frame, id: 2 }, ctx);
    release();
    expect(await first).toEqual({ id: 1, ok: true, result: { token: TOKEN_VIEW, value: VALUE } });
    expect(await second).toEqual({ id: 2, ok: true, result: { token: TOKEN_VIEW, value: VALUE } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never hands an in-flight secret to another credential of the same user: conflict, the handler runs once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { dispatch, spy } = dispatcherBed(async () => {
      await gate;
      return { token: TOKEN_VIEW, value: VALUE };
    });
    const elsewhere: HandlerContext = { ...ctx, caller: testCaller({ credentialId: "another-device" }) };
    const first = dispatch(frame, ctx);
    const second = dispatch({ ...frame, id: 2 }, elsewhere);
    release();
    expect(await second).toEqual({ id: 2, ok: false, error: { code: "conflict" } });
    expect(await first).toEqual({ id: 1, ok: true, result: { token: TOKEN_VIEW, value: VALUE } });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
