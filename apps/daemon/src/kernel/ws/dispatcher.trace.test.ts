import { PapError, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../logger.ts";
import type { ReceiptStore } from "../db/receipts.ts";
import { testCaller } from "../../testing/caller.ts";
import { createDispatcher } from "./dispatcher.ts";
import { NO_CLIENT_PATHS } from "./client-path-gate.ts";

const receipts: ReceiptStore = {
  find: () => null,
  save: () => {},
  purge: () => 0,
  readOnly: false,
};
const ctx: HandlerContext = {
  caller: testCaller(),
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
};
const handlers = {
  "sessions.abort": async () => ({ ok: true }),
  "sessions.clone": async () => {
    throw new PapError("capacity");
  },
  "sessions.respondDialog": async () => {
    throw new Error("boom");
  },
} as unknown as HandlerTable;

const abort = (id: number) => ({
  id,
  method: "sessions.abort",
  commandId: `cmd-0000010${id}`,
  params: { sessionId: "s" },
});
const RESPOND = { sessionId: "s", dialogId: "d", response: { confirmed: true } };

function setup(onCall?: (method: string, durationMs: number, outcome: string) => void) {
  const calls: Array<{ method: string; durationMs: number; outcome: string }> = [];
  const dispatch = createDispatcher({
    gate: NO_CLIENT_PATHS,
    handlers,
    receipts,
    logger: silentLogger,
    onCall: onCall ?? ((method, durationMs, outcome) => void calls.push({ method, durationMs, outcome })),
  });
  return { dispatch, calls };
}

describe("dispatcher onCall", () => {
  it("reports a successful call once, with ok", async () => {
    const { dispatch, calls } = setup();
    await dispatch(abort(1), ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "sessions.abort", outcome: "ok" });
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a failing call once, with its code", async () => {
    const { dispatch, calls } = setup();
    await dispatch(
      { id: 2, method: "sessions.clone", commandId: "cmd-00000001", params: { sessionId: "s" } },
      ctx,
    );
    await dispatch({ id: 3, method: "nope" }, ctx);
    expect(calls.map((call) => [call.method, call.outcome])).toEqual([
      ["sessions.clone", "capacity"],
      ["nope", "unknown_method"],
    ]);
  });

  it("reports a handler that throws as internal", async () => {
    const { dispatch, calls } = setup();
    await dispatch(
      { id: 4, method: "sessions.respondDialog", commandId: "cmd-00000002", params: RESPOND },
      ctx,
    );
    expect(calls.map((call) => call.outcome)).toEqual(["internal"]);
  });

  it("does not let a throwing observer fail the call", async () => {
    const { dispatch } = setup(() => {
      throw new Error("tracer broke");
    });
    expect(await dispatch(abort(5), ctx)).toMatchObject({ id: 5, ok: true });
  });
});
