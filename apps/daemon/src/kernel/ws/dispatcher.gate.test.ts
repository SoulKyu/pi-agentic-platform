import { type Caller, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ReceiptStore } from "../db/receipts.ts";
import { silentLogger } from "../logger.ts";
import { createFakeProjectBoxSource } from "../testing/fake-boxes.ts";
import { testCaller } from "../../testing/caller.ts";
import { createClientPathGate } from "./client-path-gate.ts";
import { createDispatcher } from "./dispatcher.ts";

const ROOT = "/boxes/p1/project";
const source = createFakeProjectBoxSource({
  p1: {
    ownerId: "m1",
    root: ROOT,
    resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
    hosts: [],
    deleting: false,
  },
});
const receipts: ReceiptStore = {
  find: () => null,
  save: () => undefined,
  purge: () => 0,
  readOnly: false,
};
const ctx = (caller: Caller): HandlerContext => ({
  caller,
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
});

function setup() {
  const read = vi.fn(async () => ({ paths: [], truncated: false }));
  const create = vi.fn(async () => ({ sessionId: "s1" }));
  const hasPath = vi.fn(async () => ({}));
  const handlers = {
    "files.search": read,
    "sessions.create": create,
    "sessions.list": hasPath,
  } as unknown as HandlerTable;
  const gate = createClientPathGate({ isMember: (id) => id === "m1", boxes: () => source });
  return { read, create, dispatch: createDispatcher({ handlers, receipts, logger: silentLogger, gate }) };
}

describe("the dispatcher's host gate", () => {
  it("refuses a member's host path before the handler, for an idempotent and a mutating method", async () => {
    const { dispatch, read, create } = setup();
    const member = testCaller({ userId: "m1" });
    const hostRead = await dispatch(
      { id: 1, method: "files.search", params: { root: "/etc", query: "a" } },
      ctx(member),
    );
    expect(hostRead).toEqual({ id: 1, ok: false, error: { code: "forbidden" } });
    const hostCreate = await dispatch(
      { id: 2, method: "sessions.create", params: { cwd: "/home/ubuntu" }, commandId: "c-1" },
      ctx(member),
    );
    expect(hostCreate).toEqual({ id: 2, ok: false, error: { code: "forbidden" } });
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("lets the owner's host path and a member's box path through", async () => {
    const { dispatch, read, create } = setup();
    const owner = await dispatch(
      { id: 1, method: "files.search", params: { root: "/home/ubuntu", query: "a" } },
      ctx(testCaller({ userId: "u1" })),
    );
    expect(owner.ok).toBe(true);
    const boxed = await dispatch(
      { id: 2, method: "sessions.create", params: { cwd: `${ROOT}/src` }, commandId: "c-2" },
      ctx(testCaller({ userId: "m1" })),
    );
    expect(boxed.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("walks a path the schema nests, and a parse failure stays bad_request", async () => {
    const { dispatch } = setup();
    const member = ctx(testCaller({ userId: "m1" }));
    expect(
      await dispatch({ id: 1, method: "files.search", params: { root: "relative", query: "a" } }, member),
    ).toEqual({
      id: 1,
      ok: false,
      error: { code: "bad_request" },
    });
  });
});
