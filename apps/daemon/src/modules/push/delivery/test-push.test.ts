import { PapError, PushWire } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../../../kernel/testing/outbox-bed.ts";
import { testCaller } from "../../../testing/caller.ts";
import { PUSH_MIGRATIONS } from "../index.ts";
import { createFakeTransport, type FakeTransport } from "../testing/fake-transport.ts";
import { createMemorySubscriptions, type MemorySubscriptions } from "../testing/memory-subscriptions.ts";
import { target } from "../testing/send-bed.ts";
import { deliveryRpc } from "./rpc.ts";
import { createTestPush } from "./test-push.ts";

let bed: OutboxBed;
let transport: FakeTransport;
let subs: MemorySubscriptions;
let testPush: ReturnType<typeof createTestPush>;
beforeEach(() => {
  bed = openOutboxBed([PUSH_MIGRATIONS]);
  transport = createFakeTransport();
  subs = createMemorySubscriptions();
  testPush = createTestPush({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    transport,
    subscriptions: subs,
  });
});
afterEach(() => bed.close());

const mine = testCaller({ userId: "u1", credentialId: "c-a" });
const wire = (call: number) =>
  PushWire.parse(JSON.parse(new TextDecoder().decode(transport.sent[call]?.plaintext)));
const reject = async (work: Promise<unknown>) => (await work.catch((e: unknown) => e)) as PapError;

describe("push.test.rate-limited-and-own-devices", () => {
  it("messages only the caller's own credential and writes a test event", async () => {
    subs.add("u1", target("a", "fr"));
    subs.add("u1", target("b"));
    expect(await testPush(mine)).toEqual({ delivered: 1, dropped: 0 });
    expect(transport.sent.map((c) => c.target.id)).toEqual(["a"]);
    expect(transport.sent[0]?.opts).toMatchObject({ urgency: "normal", ttlSeconds: 3600 });
    expect(wire(0)).toMatchObject({ cls: "test", title: "pap", body: "Notification de test." });
    const row = bed.db.get<{ id: string; ref_kind: string; state: string }>(
      "SELECT id, ref_kind, state FROM push_events WHERE cls = 'test'",
    );
    expect(row).toMatchObject({ ref_kind: "test", state: "sent" });
    expect(wire(0).id).toBe(row?.id);
    expect(transport.sent[0]?.opts.topic).toBe(row?.id);
  });

  it("answers rate_limited for a second call within 10 s, then allows one", async () => {
    subs.add("u1", target("a"));
    await testPush(mine);
    expect((await reject(testPush(mine))).code).toBe("rate_limited");
    expect(transport.sent).toHaveLength(1);
    await bed.clock.advance(10_000);
    expect(await testPush(mine)).toEqual({ delivered: 1, dropped: 0 });
  });

  it("the limit is per owner", async () => {
    subs.add("u1", target("a"));
    subs.add("u2", { ...target("z"), credentialId: "c-z" });
    await testPush(mine);
    expect(await testPush(testCaller({ userId: "u2", credentialId: "c-z" }))).toEqual({
      delivered: 1,
      dropped: 0,
    });
  });

  it("counts a gone device as dropped and removes it", async () => {
    subs.add("u1", target("a"));
    transport.next({ kind: "gone" });
    expect(await testPush(mine)).toEqual({ delivered: 0, dropped: 1 });
    expect(subs.dropped).toEqual([{ id: "a", why: "gone" }]);
  });

  it("a failing send delivers nothing and does not throw", async () => {
    subs.add("u1", target("a"));
    transport.next({ kind: "retry" });
    expect(await testPush(mine)).toEqual({ delivered: 0, dropped: 0 });
    expect(bed.db.get("SELECT state FROM push_events WHERE cls = 'test'")).toEqual({ state: "failed" });
  });

  it("a throwing transport is a failed send, logged by class only", async () => {
    subs.add("u1", target("a"));
    transport.send = async () => {
      throw new TypeError("https://push.example.net/secret-path-a is not a URL");
    };
    expect(await testPush(mine)).toEqual({ delivered: 0, dropped: 0 });
    expect(JSON.stringify(bed.logs)).not.toContain("secret-path");
  });

  it("answers push_unavailable when the transport is off, without spending the limit", async () => {
    subs.add("u1", target("a"));
    transport.setStatus(false);
    expect((await reject(testPush(mine))).code).toBe("push_unavailable");
    transport.setStatus(true);
    expect(await testPush(mine)).toEqual({ delivered: 1, dropped: 0 });
  });

  it("a token is forbidden before anything is read", async () => {
    subs.add("u1", target("a"));
    expect((await reject(testPush(testCaller({ kind: "token" })))).code).toBe("forbidden");
    expect(transport.sent).toEqual([]);
    expect(bed.db.all("SELECT 1 FROM push_events")).toEqual([]);
  });

  it("no device for this credential: nothing delivered, the event is cancelled", async () => {
    subs.add("u1", { ...target("a"), credentialId: "other" });
    expect(await testPush(mine)).toEqual({ delivered: 0, dropped: 0 });
    expect(bed.db.get("SELECT state, reason FROM push_events WHERE cls = 'test'")).toEqual({
      state: "cancelled",
      reason: "no_target",
    });
  });
});

describe("push.test through the delivery RPC", () => {
  it("decodes, calls the service and returns its result; a token is forbidden before the service", async () => {
    subs.add("u1", target("a"));
    const handler = deliveryRpc({ test: testPush })["push.test"];
    const ctx = (caller: Parameters<typeof testPush>[0]) => ({ caller }) as Parameters<typeof handler>[1];
    await expect(handler({}, ctx(testCaller({ kind: "token" })))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await handler({}, ctx(mine))).toEqual({ delivered: 1, dropped: 0 });
    await expect(deliveryRpc()["push.test"]({}, ctx(mine))).rejects.toMatchObject({
      code: "push_unavailable",
    });
  });
});
