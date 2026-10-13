import { type Caller, type HandlerContext, type HandlerTable, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { systemHandlers } from "../../kernel/ws/system-handlers.ts";
import { sessionsRpc } from "./rpc.ts";
import { createSessionsService, type SessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { testCaller } from "../../testing/caller.ts";

const owner: Caller = testCaller();
const ctx: HandlerContext = {
  caller: owner,
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
};

const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

// The sessions handlers behind the real dispatcher and the real receipt table: what a client's commandId does to them.
function dispatcherOver(service: SessionsService) {
  const receipts = createReceiptStore(bed.db, bed.clock);
  const handlers = { ...systemHandlers(bed.clock), ...sessionsRpc(service) } as HandlerTable;
  return { dispatch: createDispatcher({ handlers, receipts, logger: silentLogger }), receipts };
}
const prompt = (id: number, commandId?: string) => ({
  id,
  method: "sessions.prompt",
  params: { sessionId: "p1", text: "hi" },
  ...(commandId ? { commandId } : {}),
});
const promptsSent = () => bed.spawned[0]?.requests.filter((request) => request.type === "prompt").length;

describe("sessions behind the dispatcher", () => {
  it("asks every mutation for a commandId and every read for none", async () => {
    bed = build();
    const { dispatch } = dispatcherOver(bed.service);
    expect(await dispatch({ id: 1, method: "sessions.create", params: { cwd: bed.work } }, ctx)).toEqual({
      id: 1,
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await dispatch({ id: 2, method: "sessions.list" }, ctx)).toEqual({
      id: 2,
      ok: true,
      result: { sessions: [] },
    });
    expect(bed.spawned).toHaveLength(0);
  });

  it("runs a prompt once for a commandId, however often the client sends it", async () => {
    bed = build();
    const { dispatch } = dispatcherOver(bed.service);
    await bed.service.create(bed.work, owner);
    const first = await dispatch(prompt(1, "command-0001"), ctx);
    const again = await dispatch(prompt(2, "command-0001"), ctx);
    expect(first).toEqual({ id: 1, ok: true, result: { disposition: "started" } });
    expect(again).toEqual({ id: 2, ok: true, result: { disposition: "started" } });
    expect(promptsSent()).toBe(1);
  });

  it("stores nothing for a command whose outcome is unknown, so the client decides what to do (R105)", async () => {
    bed = build();
    let attempts = 0;
    const flaky: SessionsService = {
      ...bed.service,
      prompt: async () => {
        attempts++;
        if (attempts === 1) throw new PapError("timeout");
        return { disposition: "started" };
      },
    };
    const { dispatch, receipts } = dispatcherOver(flaky);
    expect(await dispatch(prompt(1, "command-0002"), ctx)).toEqual({
      id: 1,
      ok: false,
      error: { code: "timeout" },
    });
    expect(receipts.find("u1", "command-0002")).toBeNull();
    // Nothing retries by itself: the second attempt is the client's own, and it runs again.
    expect(attempts).toBe(1);
    expect(await dispatch(prompt(2, "command-0002"), ctx)).toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });

  it("aborts once for a commandId: replaying it does not stop a newer run (R110)", async () => {
    bed = build();
    const { dispatch } = dispatcherOver(bed.service);
    await bed.service.create(bed.work, owner);
    const abort = (id: number, commandId?: string) => ({
      id,
      method: "sessions.abort",
      params: { sessionId: "p1" },
      ...(commandId ? { commandId } : {}),
    });
    // Without a commandId there is no abort: it is a mutation like the others.
    expect(await dispatch(abort(1), ctx)).toEqual({ id: 1, ok: false, error: { code: "bad_request" } });
    bed.emit(0, { type: "agent_start" });
    expect(await dispatch(abort(2, "command-abort1"), ctx)).toEqual({
      id: 2,
      ok: true,
      result: { ok: true },
    });
    expect(bed.service.list(owner)[0]?.status).toBe("idle");
    // A new run starts; the client, not sure its answer arrived, sends the same command again.
    bed.emit(0, { type: "agent_start" });
    const stateRequests = () =>
      bed.spawned[0]?.requests.filter((request) => request.type === "get_state").length;
    const before = stateRequests();
    expect(await dispatch(abort(3, "command-abort1"), ctx)).toEqual({
      id: 3,
      ok: true,
      result: { ok: true },
    });
    expect(stateRequests()).toBe(before);
    expect(bed.service.list(owner)[0]?.status).toBe("running");
  });
});
