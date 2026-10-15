import {
  type Caller,
  type HandlerContext,
  type HandlerTable,
  PapError,
  TOKEN_PERMISSIONS,
} from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { modelsRpc } from "./rpc.ts";
import { USAGE_CACHE_MS } from "./usage.ts";
import { modelsBed } from "./testing/bed.ts";

const report = {
  providerId: "openrouter",
  providerName: "OpenRouter",
  capturedAt: 1_700_000_000_000,
  buckets: [{ id: "key-limit", label: "Key limit", used: 1, remaining: 9, limit: 10, unit: "currency" }],
  metrics: [],
};
const ready = { status: "ready", report };
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );
const caller = testCaller();

describe("models.usage", () => {
  it("is refused to a token before any handler or helper runs (pi:admin)", async () => {
    const { service, calls } = modelsBed(() => ready);
    const handlers = modelsRpc(service) as unknown as HandlerTable;
    const dispatch = createDispatcher({
      handlers,
      receipts: { find: () => null, save: () => {}, purge: () => 0, readOnly: false },
      logger: silentLogger,
    });
    const ctx = (who: Caller): HandlerContext => ({
      caller: who,
      connectionId: "c1",
      openSubscription: () => "s1",
      closeSubscription: () => {},
    });
    const token = testCaller({
      kind: "token",
      credentialId: "tok1",
      permissions: new Set(TOKEN_PERMISSIONS),
    });
    const params = { providerId: "openrouter" };
    expect(await dispatch({ id: 1, method: "models.usage", params }, ctx(token))).toEqual({
      id: 1,
      ok: false,
      error: { code: "forbidden" },
    });
    expect(calls).toHaveLength(0);
    const owner = await dispatch({ id: 2, method: "models.usage", params }, ctx(caller));
    expect(owner).toMatchObject({ id: 2, ok: true, result: ready });
    expect(calls).toHaveLength(1);
  });

  it("runs one helper operation with a deadline, no cwd, and returns the parsed answer", async () => {
    const { service, calls } = modelsBed(() => ready);
    expect(await service.usage(caller, { providerId: "openrouter" })).toEqual(ready);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "models.usage", params: { providerId: "openrouter" } });
    expect(calls[0]?.options.cwd).toBeUndefined();
    expect(calls[0]?.options.deadlineMs).toBe(60_000);
  });

  it("keeps one answer per provider for 60 s: a loop makes one helper run a minute", async () => {
    const { service, calls, clock } = modelsBed(() => ready);
    await service.usage(caller, { providerId: "openrouter" });
    await service.usage(caller, { providerId: "openrouter" });
    await clock.advance(USAGE_CACHE_MS - 1);
    await service.usage(caller, { providerId: "openrouter" });
    expect(calls).toHaveLength(1);
    await service.usage(caller, { providerId: "deepseek" });
    expect(calls).toHaveLength(2);
    await clock.advance(1);
    await service.usage(caller, { providerId: "openrouter" });
    expect(calls).toHaveLength(3);
    expect(USAGE_CACHE_MS).toBe(60_000);
  });

  it("keeps a failed query for the minute too, so a broken key is not asked in a loop", async () => {
    const { service, calls } = modelsBed(() => ({ status: "query_failed" }));
    await service.usage(caller, { providerId: "openrouter" });
    expect(await service.usage(caller, { providerId: "openrouter" })).toEqual({ status: "query_failed" });
    expect(calls).toHaveLength(1);
  });

  it("shares one run between calls made while it is in flight, and keeps nothing of a helper error", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    const { service, calls } = modelsBed(() => gate);
    const first = service.usage(caller, { providerId: "openrouter" });
    const second = service.usage(caller, { providerId: "openrouter" });
    expect(calls).toHaveLength(1);
    release(ready);
    expect(await Promise.all([first, second])).toEqual([ready, ready]);

    const failing = modelsBed(() => new PapError("helper_failed"));
    expect(await codeOf(failing.service.usage(caller, { providerId: "openrouter" }))).toBe("helper_failed");
    expect(await codeOf(failing.service.usage(caller, { providerId: "openrouter" }))).toBe("helper_failed");
    expect(failing.calls).toHaveLength(2);
  });

  it("answers unsupported for a provider outside the ten without a helper run, and keeps nothing for it", async () => {
    const { service, calls } = modelsBed(() => ready);
    for (const providerId of ["anthropic", "__proto__", "x".repeat(128)])
      expect(await service.usage(caller, { providerId })).toEqual({ status: "unsupported" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a helper answer carrying a field the contract does not name, and logs nothing of it", async () => {
    const leaky = modelsBed(() => ({ status: "ready", report, apiKey: "sk-LEAK" }));
    expect(await codeOf(leaky.service.usage(caller, { providerId: "openrouter" }))).toBe("helper_failed");
    const bucketLeak = modelsBed(() => ({
      status: "ready",
      report: { ...report, buckets: [{ ...report.buckets[0], token: "sk-LEAK" }] },
    }));
    expect(await codeOf(bucketLeak.service.usage(caller, { providerId: "openrouter" }))).toBe(
      "helper_failed",
    );
    expect(JSON.stringify([leaky.lines, bucketLeak.lines])).not.toContain("sk-LEAK");
  });
});
