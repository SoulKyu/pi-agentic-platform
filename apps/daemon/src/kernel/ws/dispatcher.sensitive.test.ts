import type { HandlerContext, HandlerTable } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ReceiptStore } from "../db/receipts.ts";
import { sha256Hex } from "../ids.ts";
import { silentLogger } from "../logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { canonicalJson, createDispatcher } from "./dispatcher.ts";
import { NO_CLIENT_PATHS } from "./client-path-gate.ts";

// MC30: a receipt must not hold a hash of a secret. A key typed by the owner has little entropy next to its length, and
// a stored SHA-256 of it can be tried against guesses by anyone who reads the database or a backup.
const ctx: HandlerContext = {
  caller: testCaller(),
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
};
const SECRET = "sk-test-SECRET-0123456789";
// `moved` changes a selector field; `retyped` changes only the secret.
const CALLS = [
  {
    method: "models.setApiKey",
    params: { provider: "anthropic", key: SECRET },
    moved: { provider: "openai", key: SECRET },
    retyped: { provider: "anthropic", key: "sk-other" },
  },
  {
    method: "models.loginAnswer",
    params: { flowId: "f1", promptId: "p1", value: SECRET },
    moved: { flowId: "f2", promptId: "p1", value: SECRET },
    retyped: { flowId: "f1", promptId: "p1", value: "other" },
  },
  {
    method: "models.config.save",
    params: { text: `{"apiKey":"${SECRET}"}`, baseRevision: "a".repeat(64) },
    moved: { text: `{"apiKey":"${SECRET}"}`, baseRevision: "c".repeat(64) },
    retyped: { text: "{}", baseRevision: "a".repeat(64) },
  },
  {
    method: "sessions.respondDialog",
    params: { sessionId: "s1", dialogId: "d1", response: { value: SECRET } },
    moved: { sessionId: "s1", dialogId: "d2", response: { value: SECRET } },
    retyped: { sessionId: "s1", dialogId: "d1", response: { value: "other" } },
  },
] as const;

function bed() {
  const stored = new Map<string, { method: string; result: unknown }>();
  const receipts: ReceiptStore = {
    find: (userId, commandId) => stored.get(`${userId}:${commandId}`) ?? null,
    save: (userId, commandId, method, result) =>
      void stored.set(`${userId}:${commandId}`, { method, result }),
    purge: () => 0,
    readOnly: false,
  };
  const handler = vi.fn();
  const answers: Record<string, unknown> = {
    "models.setApiKey": { ok: true },
    "models.loginAnswer": { ok: true },
    "models.config.save": { revision: "b".repeat(64), enabledModelsSynced: true },
    "sessions.respondDialog": { ok: true },
  };
  const handlers = Object.fromEntries(
    CALLS.map((call) => [
      call.method,
      async () => {
        handler(call.method);
        return answers[call.method];
      },
    ]),
  ) as unknown as HandlerTable;
  return {
    dispatch: createDispatcher({ gate: NO_CLIENT_PATHS, handlers, receipts, logger: silentLogger }),
    dump: () => JSON.stringify([...stored.values()]),
    handler,
  };
}

describe.each(CALLS)("receipt of $method (MC30)", ({ method, params, moved, retyped }) => {
  it("holds no hash of the params, nor the params", async () => {
    const { dispatch, dump } = bed();
    expect((await dispatch({ id: 1, method, params, commandId: "cmd-00000001" }, ctx)).ok).toBe(true);
    expect(dump()).not.toContain(sha256Hex(canonicalJson(params)));
    expect(dump()).not.toContain(SECRET);
  });

  it("replays the stored answer for the same command, runs the handler once", async () => {
    const { dispatch, handler } = bed();
    const first = await dispatch({ id: 1, method, params, commandId: "cmd-00000001" }, ctx);
    expect(await dispatch({ id: 2, method, params, commandId: "cmd-00000001" }, ctx)).toEqual({
      ...first,
      id: 2,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays for the same selector whatever was typed, and refuses another selector under the command id", async () => {
    const { dispatch, handler } = bed();
    const first = await dispatch({ id: 1, method, params, commandId: "cmd-00000001" }, ctx);
    expect(await dispatch({ id: 2, method, params: retyped, commandId: "cmd-00000001" }, ctx)).toEqual({
      ...first,
      id: 2,
    });
    expect(await dispatch({ id: 3, method, params: moved, commandId: "cmd-00000001" }, ctx)).toEqual({
      id: 3,
      ok: false,
      error: { code: "bad_request" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still refuses the same command id on another method", async () => {
    const { dispatch } = bed();
    await dispatch({ id: 1, method, params, commandId: "cmd-00000001" }, ctx);
    const other = CALLS.find((call) => call.method !== method) ?? CALLS[0];
    expect(
      await dispatch({ id: 2, method: other.method, params: other.params, commandId: "cmd-00000001" }, ctx),
    ).toEqual({ id: 2, ok: false, error: { code: "bad_request" } });
  });
});

describe("an ordinary mutation keeps its params hash", () => {
  it("compares the params of a replay, so a different body under one command id is refused", async () => {
    const stored = new Map<string, { method: string; result: unknown }>();
    const receipts: ReceiptStore = {
      find: (u, c) => stored.get(`${u}:${c}`) ?? null,
      save: (u, c, method, result) => void stored.set(`${u}:${c}`, { method, result }),
      purge: () => 0,
      readOnly: false,
    };
    const dispatch = createDispatcher({
      gate: NO_CLIENT_PATHS,
      handlers: { "models.logout": async () => ({ ok: true }) } as unknown as HandlerTable,
      receipts,
      logger: silentLogger,
    });
    await dispatch(
      { id: 1, method: "models.logout", params: { provider: "a" }, commandId: "cmd-00000009" },
      ctx,
    );
    expect(
      await dispatch(
        { id: 2, method: "models.logout", params: { provider: "b" }, commandId: "cmd-00000009" },
        ctx,
      ),
    ).toEqual({ id: 2, ok: false, error: { code: "bad_request" } });
  });
});
