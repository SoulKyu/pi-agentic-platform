import {
  type Caller,
  type ExtensionProviders,
  type HandlerContext,
  type HandlerTable,
  PapError,
  TOKEN_PERMISSIONS,
} from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { testCaller } from "../../testing/caller.ts";
import { modelsRpc } from "./rpc.ts";
import { modelsBed } from "./testing/bed.ts";

const found: ExtensionProviders = {
  truncated: false,
  providers: [
    {
      id: "ext1",
      name: "Ext",
      modelsTruncated: false,
      models: [{ provider: "ext1", id: "m", name: "M", reasoning: false, offered: true, enabled: true }],
    },
  ],
  failed: false,
};
const owner = testCaller();
const ctx = (who: Caller): HandlerContext => ({
  caller: who,
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
});
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

function bedOf(answer: (op: string) => unknown) {
  const bed = modelsBed((call) => answer(call.op));
  const handlers = modelsRpc(bed.service) as unknown as HandlerTable;
  const dispatch = createDispatcher({
    handlers,
    receipts: { find: () => null, save: () => {}, purge: () => 0, readOnly: false },
    logger: silentLogger,
  });
  return { ...bed, dispatch };
}

describe("models.extensions (daemon)", () => {
  it("is refused to a token before any handler or helper runs (pi:admin)", async () => {
    const { dispatch, calls } = bedOf(() => found);
    const token = testCaller({
      kind: "token",
      credentialId: "tok1",
      permissions: new Set(TOKEN_PERMISSIONS),
    });
    expect(await dispatch({ id: 1, method: "models.extensions", params: {} }, ctx(token))).toEqual({
      id: 1,
      ok: false,
      error: { code: "forbidden" },
    });
    expect(calls).toHaveLength(0);
    expect(await dispatch({ id: 2, method: "models.extensions", params: {} }, ctx(owner))).toMatchObject({
      id: 2,
      ok: true,
      result: found,
    });
    expect(calls.map((call) => call.op)).toEqual(["models.extensions"]);
  });

  it("asks the helper without a cwd (global extensions only) and needs no step-up", async () => {
    const { service, calls } = bedOf(() => found);
    expect(await service.extensions()).toEqual(found);
    expect(calls[0]?.options.cwd).toBeUndefined();
    expect(calls[0]?.params).toEqual({});
  });

  it("shares one helper run between concurrent clicks, and asks again later (nothing is kept)", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    const { service, calls } = bedOf(() => gate);
    const first = service.extensions();
    const second = service.extensions();
    release(found);
    expect(await Promise.all([first, second])).toEqual([found, found]);
    expect(calls).toHaveLength(1);
    await service.extensions();
    expect(calls).toHaveLength(2);
  });

  it("does not keep a helper error: the next click asks again", async () => {
    let fail = true;
    const { service, calls } = bedOf(() => (fail ? new PapError("helper_failed") : found));
    expect(await codeOf(service.extensions())).toBe("helper_failed");
    fail = false;
    expect(await service.extensions()).toEqual(found);
    expect(calls).toHaveLength(2);
  });

  it("passes a failed answer through as it is", async () => {
    const { service } = bedOf(() => ({ providers: [], truncated: false, failed: true }));
    expect(await service.extensions()).toEqual({ providers: [], truncated: false, failed: true });
  });
});
