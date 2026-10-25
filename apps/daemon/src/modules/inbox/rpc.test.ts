import { type Caller, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { testCaller } from "../../testing/caller.ts";
import { inboxRpc } from "./rpc.ts";
import { createInboxBed, type InboxBed } from "./testing/bed.ts";
import { NO_CLIENT_PATHS } from "../../kernel/ws/client-path-gate.ts";

let bed: InboxBed;
afterEach(() => bed.dispose());

function setup() {
  bed = createInboxBed();
  const dispatch = createDispatcher({
    gate: NO_CLIENT_PATHS,
    handlers: inboxRpc(bed.inbox) as unknown as HandlerTable,
    receipts: createReceiptStore(bed.db, bed.clock),
    logger: bed.logger,
  });
  const opened: Array<[string, string]> = [];
  let frameId = 0;
  const call = (method: string, params: unknown, caller: Caller = testCaller()) => {
    const ctx: HandlerContext = {
      caller,
      connectionId: "c1",
      openSubscription: (stream, key) => {
        opened.push([stream, key]);
        return "sub-1";
      },
      closeSubscription: () => {},
    };
    return dispatch({ id: ++frameId, method, params, commandId: `c-${frameId}` }, ctx);
  };
  return { call, opened };
}

function twoOpenItems() {
  bed.addTask("t1");
  bed.addTask("t2");
  bed.move("t1", "done");
  bed.move("t2", "failed");
  return bed.inbox.snapshot("u1").items.map((item) => item.id);
}

describe("inbox.markRead", () => {
  it("marks the ids it is given, and no other", async () => {
    const { call } = setup();
    const [first, second] = twoOpenItems() as [string, string];
    const reply = await call("inbox.markRead", { ids: [first] });
    expect(reply).toMatchObject({ ok: true, result: { updated: 1 } });
    const items = bed.inbox.snapshot("u1").items;
    expect(items.find((item) => item.id === first)?.readAt).not.toBeNull();
    expect(items.find((item) => item.id === second)?.readAt).toBeNull();
    expect(bed.inbox.snapshot("u1").unread).toBe(1);
  });

  it("marks everything with all, and tells the open stream", async () => {
    const { call } = setup();
    twoOpenItems();
    const frames = bed.open("u1");
    frames.length = 0;
    await call("inbox.markRead", { all: true });
    expect(bed.inbox.snapshot("u1").unread).toBe(0);
    expect(frames.map((frame) => (frame.event as { kind: string }).kind)).toEqual(["item", "item", "counts"]);
  });

  it("refuses more than 200 ids as bad_request", async () => {
    const { call } = setup();
    twoOpenItems();
    const ids = Array.from({ length: 201 }, (_, index) => `i${index}`);
    expect(await call("inbox.markRead", { ids })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(bed.inbox.snapshot("u1").unread).toBe(2);
  });

  it("changes nothing for another owner's id", async () => {
    const { call } = setup();
    const [first] = twoOpenItems() as [string];
    const reply = await call("inbox.markRead", { ids: [first] }, testCaller({ userId: "u2" }));
    expect(reply).toMatchObject({ ok: true, result: { updated: 0 } });
    expect(bed.inbox.snapshot("u1").unread).toBe(2);
  });

  it("leaves a question to handle until it is resolved, read or not", async () => {
    const { call } = setup();
    bed.addTask("t1");
    bed.attend("t1", true);
    await call("inbox.markRead", { all: true });
    expect(bed.inbox.snapshot("u1")).toMatchObject({ unread: 0, toHandle: 1 });
  });

  it("is refused to a caller without inbox:operate", async () => {
    const { call } = setup();
    const reader = testCaller({ permissions: new Set(["inbox:read"]) });
    expect(await call("inbox.markRead", { all: true }, reader)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });
});

describe("inbox.list and the stream", () => {
  it("lists the caller's own items", async () => {
    const { call } = setup();
    twoOpenItems();
    const reply = (await call("inbox.list", {}, testCaller({ userId: "u2" }))) as {
      result: { items: unknown[] };
    };
    expect(reply.result.items).toEqual([]);
    const own = (await call("inbox.list", {})) as { result: { items: unknown[]; hasMore: boolean } };
    expect(own.result.items).toHaveLength(2);
    expect(own.result.hasMore).toBe(false);
  });

  it("opens the stream keyed by the caller's own id, never by a param", async () => {
    const { call, opened } = setup();
    const reply = await call("subscribe.inbox", {}, testCaller({ userId: "u7" }));
    expect(reply).toMatchObject({ ok: true, result: { sub: "sub-1" } });
    expect(opened).toEqual([["inbox", "u7"]]);
    expect(await call("subscribe.inbox", { key: "u1" })).toMatchObject({ ok: false });
  });
});
