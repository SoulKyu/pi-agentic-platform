import { PapError, type Caller, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../clock.ts";
import type { ReceiptStore } from "../db/receipts.ts";
import { silentLogger, type LogFields, type Logger } from "../logger.ts";
import { sha256Hex } from "../ids.ts";
import { canonicalJson, createDispatcher } from "./dispatcher.ts";
import { systemHandlers } from "./system-handlers.ts";
import { testCaller } from "../../testing/caller.ts";

const owner: Caller = testCaller();
const ctx = (caller: Caller = owner): HandlerContext => ({
  caller,
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
});
const create = (id: number, commandId: string, cwd = "/tmp") => ({
  id,
  method: "sessions.create",
  params: { cwd },
  commandId,
});

function setup(overrides: Partial<ReceiptStore> = {}) {
  const stored = new Map<string, { method: string; result: unknown }>();
  const receipts: ReceiptStore = {
    find: (userId, commandId) => stored.get(`${userId}:${commandId}`) ?? null,
    save: (userId, commandId, method, result) => {
      stored.set(`${userId}:${commandId}`, { method, result });
    },
    purge: () => 0,
    readOnly: false,
    ...overrides,
  };
  const errors: Array<{ msg: string; fields: LogFields | undefined }> = [];
  const logger: Logger = {
    ...silentLogger,
    error: (msg, fields) => {
      errors.push({ msg, fields });
    },
  };
  const createHandler = vi.fn(async () => ({ sessionId: "s-1" }));
  const promptHandler = vi.fn(async () => ({ disposition: "started" as const }));
  const handlers = {
    ...systemHandlers(createFakeClock(5)),
    "sessions.create": createHandler,
    "sessions.prompt": promptHandler,
    "sessions.list": async () => {
      throw new PapError("not_found");
    },
    "sessions.clone": async () => {
      throw new PapError("capacity", { workers: { used: 6, max: 6 } });
    },
    "sessions.abort": async () => {
      throw new Error("attempt to write a readonly database");
    },
    "sessions.respondDialog": async () => {
      throw new Error("boom");
    },
  } as unknown as HandlerTable;
  return {
    dispatch: createDispatcher({ handlers, receipts, logger }),
    create: createHandler,
    prompt: promptHandler,
    stored,
    errors,
  };
}

describe("dispatcher", () => {
  it("answers unknown_method for unknown names and prototype keys", async () => {
    const { dispatch } = setup();
    for (const method of ["nope", "constructor", "__proto__", "toString"]) {
      expect(await dispatch({ id: 1, method }, ctx())).toEqual({
        id: 1,
        ok: false,
        error: { code: "unknown_method" },
      });
    }
  });

  it("checks the permission before anything else", async () => {
    const { dispatch, create: handler } = setup();
    const reader: Caller = testCaller({ permissions: new Set(["sessions:read"]) });
    expect(await dispatch(create(2, "cmd-00000001"), ctx(reader))).toEqual({
      id: 2,
      ok: false,
      error: { code: "forbidden" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects invalid params and mutations without commandId", async () => {
    const { dispatch, create: handler } = setup();
    const invalid = { id: 3, method: "sessions.create", params: { cwd: 42 }, commandId: "cmd-00000002" };
    expect((await dispatch(invalid, ctx())).ok).toBe(false);
    expect(await dispatch({ id: 4, method: "sessions.create", params: { cwd: "/tmp" } }, ctx())).toEqual({
      id: 4,
      ok: false,
      error: { code: "bad_request" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs read methods without a commandId and stores no receipt for them", async () => {
    const { dispatch, stored } = setup();
    expect(await dispatch({ id: 11, method: "system.ping", params: {} }, ctx())).toEqual({
      id: 11,
      ok: true,
      result: { now: 5 },
    });
    expect(stored.size).toBe(0);
  });

  it("returns the stored result for a repeated commandId without re-running the handler", async () => {
    const { dispatch, create: handler } = setup();
    const frame = create(5, "cmd-00000003");
    const [a, b] = await Promise.all([dispatch(frame, ctx()), dispatch({ ...frame, id: 6 }, ctx())]);
    const c = await dispatch({ ...frame, id: 7 }, ctx());
    expect([a, b, c]).toEqual([
      { id: 5, ok: true, result: { sessionId: "s-1" } },
      { id: 6, ok: true, result: { sessionId: "s-1" } },
      { id: 7, ok: true, result: { sessionId: "s-1" } },
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("scopes receipts to the caller: another user's commandId runs its own handler", async () => {
    const { dispatch, create: handler } = setup();
    const other: Caller = testCaller({ userId: "u2" });
    await dispatch(create(1, "cmd-00000009"), ctx());
    await dispatch(create(2, "cmd-00000009"), ctx(other));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("carries the worker counts of a capacity refusal on the error", async () => {
    const { dispatch } = setup();
    const clone = { id: 7, method: "sessions.clone", params: { sessionId: "s" }, commandId: "cmd-00000009" };
    expect(await dispatch(clone, ctx())).toEqual({
      id: 7,
      ok: false,
      error: { code: "capacity", workers: { used: 6, max: 6 } },
    });
  });

  it("maps PapError to its code, readonly errors to read_only, anything else to internal", async () => {
    const { dispatch } = setup();
    expect(await dispatch({ id: 8, method: "sessions.list", params: {} }, ctx())).toEqual({
      id: 8,
      ok: false,
      error: { code: "not_found" },
    });
    const abort = { id: 9, method: "sessions.abort", params: { sessionId: "s" }, commandId: "cmd-00000003" };
    expect(await dispatch(abort, ctx())).toEqual({
      id: 9,
      ok: false,
      error: { code: "read_only" },
    });
    const respond = {
      id: 10,
      method: "sessions.respondDialog",
      params: { sessionId: "s", dialogId: "d", response: { confirmed: true } },
      commandId: "cmd-00000004",
    };
    expect(await dispatch(respond, ctx())).toEqual({ id: 10, ok: false, error: { code: "internal" } });
  });

  it("answers a worker that was slow with timeout, apart from one that died", async () => {
    const { dispatch, prompt } = setup();
    const request = (id: number, commandId: string) => ({
      id,
      method: "sessions.prompt",
      params: { sessionId: "s", text: "go" },
      commandId,
    });
    prompt
      .mockRejectedValueOnce(new PapError("timeout"))
      .mockRejectedValueOnce(new PapError("worker_failed"));
    expect(await dispatch(request(11, "cmd-00000051"), ctx())).toEqual({
      id: 11,
      ok: false,
      error: { code: "timeout" },
    });
    expect(await dispatch(request(12, "cmd-00000052"), ctx())).toEqual({
      id: 12,
      ok: false,
      error: { code: "worker_failed" },
    });
  });

  it("answers system.ping with the clock time", async () => {
    const { dispatch } = setup();
    expect(await dispatch({ id: 11, method: "system.ping", params: {} }, ctx())).toEqual({
      id: 11,
      ok: true,
      result: { now: 5 },
    });
  });
});

describe("dispatcher receipts (R69)", () => {
  it("rejects a commandId reused with another method, never replaying the stored result", async () => {
    const { dispatch, create: handler } = setup();
    await dispatch(create(1, "cmd-00000005"), ctx());
    const reused = {
      id: 2,
      method: "sessions.prompt",
      params: { sessionId: "s", text: "hi" },
      commandId: "cmd-00000005",
    };
    expect(await dispatch(reused, ctx())).toEqual({ id: 2, ok: false, error: { code: "bad_request" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a commandId reused with different params, never replaying the stored result", async () => {
    const { dispatch, create: handler } = setup();
    await dispatch(create(1, "cmd-00000006", "/tmp/a"), ctx());
    expect(await dispatch(create(2, "cmd-00000006", "/tmp/b"), ctx())).toEqual({
      id: 2,
      ok: false,
      error: { code: "bad_request" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting reuse while the first request is still running", async () => {
    const { dispatch, create: handler } = setup();
    const [first, second] = await Promise.all([
      dispatch(create(1, "cmd-00000007", "/tmp/a"), ctx()),
      dispatch(create(2, "cmd-00000007", "/tmp/b"), ctx()),
    ]);
    expect(first).toEqual({ id: 1, ok: true, result: { sessionId: "s-1" } });
    expect(second).toEqual({ id: 2, ok: false, error: { code: "bad_request" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("treats params that differ only in key order as the same request", async () => {
    const { dispatch, prompt } = setup();
    const first = {
      id: 1,
      method: "sessions.prompt",
      params: { sessionId: "s", text: "hi" },
      commandId: "cmd-00000010",
    };
    const second = {
      id: 2,
      method: "sessions.prompt",
      params: { text: "hi", sessionId: "s" },
      commandId: "cmd-00000010",
    };
    expect(await dispatch(first, ctx())).toEqual({ id: 1, ok: true, result: { disposition: "started" } });
    expect(await dispatch(second, ctx())).toEqual({ id: 2, ok: true, result: { disposition: "started" } });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("canonicalises nested objects, keeps array order and ignores undefined members", () => {
    expect(canonicalJson({ b: [2, { y: 1, x: undefined, a: null }], a: "é" })).toBe(
      '{"a":"é","b":[2,{"a":null,"y":1}]}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("stores the params hash with the result and replays only that result", async () => {
    const { dispatch, stored } = setup();
    await dispatch(create(1, "cmd-0000000a"), ctx());
    const receipt = stored.get("u1:cmd-0000000a");
    expect(receipt?.method).toBe("sessions.create");
    expect(receipt?.result).toEqual({
      paramsHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      result: { sessionId: "s-1" },
    });
  });
});

describe("dispatcher failures (R6)", () => {
  it("answers internal and logs when the receipt store throws on lookup", async () => {
    const {
      dispatch,
      create: handler,
      errors,
    } = setup({
      find: () => {
        throw new Error("disk I/O error");
      },
    });
    expect(await dispatch(create(1, "cmd-0000000b"), ctx())).toEqual({
      id: 1,
      ok: false,
      error: { code: "internal" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(errors.map((entry) => entry.msg)).toEqual(["rpc_dispatch_failed"]);
  });

  it("still returns the result when the receipt cannot be saved, and logs the code only", async () => {
    const {
      dispatch,
      create: handler,
      errors,
    } = setup({
      save: () => {
        throw Object.assign(new Error("disk full: /home/u/.pap/state.db"), { code: "ERR_SQLITE_ERROR" });
      },
    });
    expect(await dispatch(create(1, "cmd-0000000c"), ctx())).toEqual({
      id: 1,
      ok: true,
      result: { sessionId: "s-1" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([
      { msg: "receipt_save_failed", fields: { method: "sessions.create", code: "ERR_SQLITE_ERROR" } },
    ]);
  });

  it("answers internal and logs when a handler throws, without leaking its message", async () => {
    const { dispatch, errors } = setup();
    const respond = {
      id: 1,
      method: "sessions.respondDialog",
      params: { sessionId: "s", dialogId: "d", response: { confirmed: true } },
      commandId: "cmd-0000000d",
    };
    expect(await dispatch(respond, ctx())).toEqual({ id: 1, ok: false, error: { code: "internal" } });
    expect(errors.map((entry) => entry.msg)).toEqual(["rpc_handler_failed"]);
  });

  it("answers internal when the stored receipt is malformed", async () => {
    const { dispatch, create: handler } = setup({
      find: () => ({ method: "sessions.create", result: "garbage" }),
    });
    expect(await dispatch(create(1, "cmd-0000000e"), ctx())).toEqual({
      id: 1,
      ok: false,
      error: { code: "internal" },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("dispatcher on a read-only store", () => {
  it("refuses a mutation before running its handler, without logging a failure", async () => {
    const { dispatch, create: handler, errors, stored } = setup({ readOnly: true });
    expect(await dispatch(create(1, "cmd-0000000f"), ctx())).toEqual({
      id: 1,
      ok: false,
      error: { code: "read_only" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it("still serves read methods and replays a receipt it already holds", async () => {
    const { dispatch, create: handler, stored } = setup({ readOnly: true });
    stored.set("u1:cmd-00000011", {
      method: "sessions.create",
      result: { paramsHash: sha256Hex(canonicalJson({ cwd: "/tmp" })), result: { sessionId: "old" } },
    });
    expect(await dispatch({ id: 2, method: "system.ping", params: {} }, ctx())).toEqual({
      id: 2,
      ok: true,
      result: { now: 5 },
    });
    expect(await dispatch(create(3, "cmd-00000011"), ctx())).toEqual({
      id: 3,
      ok: true,
      result: { sessionId: "old" },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
