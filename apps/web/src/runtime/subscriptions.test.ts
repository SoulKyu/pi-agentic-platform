import { describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "./connection.ts";
import { RpcError, type RpcClient } from "./rpc.ts";
import { createSubscriptions } from "./subscriptions.ts";
import { fakeConnection } from "./testing.ts";

interface Deferred {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function setup(options: { manual?: boolean; state?: ConnectionState } = {}) {
  const fake = fakeConnection(options.state ?? "open");
  const calls: Array<[string, unknown]> = [];
  const replies: Deferred[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      calls.push([method, params]);
      if (!options.manual) {
        return Promise.resolve(method === "subscribe.session" ? { sub: `s${calls.length}` } : { ok: true });
      }
      return new Promise((resolve, reject) => {
        replies[calls.length - 1] = { resolve, reject };
      });
    }),
  } as unknown as RpcClient;
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers = {
    set: (fn: () => void) => {
      pending.set(next, fn);
      return next++;
    },
    clear: (id: number) => {
      pending.delete(id);
    },
  };
  const subscriptions = createSubscriptions(fake.connection, rpc, timers);
  return {
    fake,
    calls,
    replies,
    subscriptions,
    expire: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("subscriptions", () => {
  it("subscribes while open and delivers events of its sub", async () => {
    const { fake, calls, subscriptions } = setup();
    const events: unknown[] = [];
    subscriptions.subscribe("session", "k", (event) => events.push(event));
    await flush();
    expect(calls).toEqual([["subscribe.session", { sessionId: "k" }]]);
    fake.deliver({ sub: "s1", epoch: "e1", seq: 0, event: { kind: "snapshot" } });
    fake.deliver({ sub: "other", epoch: "e1", seq: 1, event: { kind: "noise" } });
    expect(events).toEqual([{ kind: "snapshot" }]);
  });

  it("resubscribes with the last cursor after a reconnect", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("session", "k", () => {});
    await flush();
    fake.deliver({ sub: "s1", epoch: "e1", seq: 3, event: {} });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k", after: { epoch: "e1", seq: 3 } }]);
  });

  it("unsubscribes when the last listener leaves and keeps the cursor for 5 minutes", async () => {
    const { fake, calls, subscriptions, expire } = setup();
    const off = subscriptions.subscribe("session", "k", () => {});
    await flush();
    fake.deliver({ sub: "s1", epoch: "e1", seq: 7, event: {} });
    off();
    expect(calls.at(-1)).toEqual(["unsubscribe", { sub: "s1" }]);
    const offAgain = subscriptions.subscribe("session", "k", () => {});
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k", after: { epoch: "e1", seq: 7 } }]);
    offAgain();
    expire();
    subscriptions.subscribe("session", "k", () => {});
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k" }]);
  });

  it("waits for the connection to open before it subscribes", async () => {
    const { fake, calls, subscriptions } = setup({ state: "connecting" });
    subscriptions.subscribe("session", "k", () => {});
    await flush();
    expect(calls).toEqual([]);
    fake.setState("open");
    await flush();
    expect(calls).toEqual([["subscribe.session", { sessionId: "k" }]]);
  });

  it("shares one subscription between listeners of a key, and ends it with the last one", async () => {
    const { fake, calls, subscriptions } = setup();
    const seen: string[] = [];
    const offA = subscriptions.subscribe("session", "k", () => seen.push("a"));
    const offB = subscriptions.subscribe("session", "k", () => seen.push("b"));
    await flush();
    expect(calls).toHaveLength(1);
    fake.deliver({ sub: "s1", epoch: "e1", seq: 1, event: {} });
    expect(seen).toEqual(["a", "b"]);
    offA();
    expect(calls).toHaveLength(1);
    offB();
    expect(calls.at(-1)).toEqual(["unsubscribe", { sub: "s1" }]);
  });

  it("keeps a separate cursor per key", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("session", "a", () => {});
    subscriptions.subscribe("session", "b", () => {});
    await flush();
    fake.deliver({ sub: "s1", epoch: "e1", seq: 4, event: {} });
    fake.deliver({ sub: "s2", epoch: "e1", seq: 9, event: {} });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.slice(2)).toEqual([
      ["subscribe.session", { sessionId: "a", after: { epoch: "e1", seq: 4 } }],
      ["subscribe.session", { sessionId: "b", after: { epoch: "e1", seq: 9 } }],
    ]);
  });

  it("replaces the cursor when a snapshot of a new epoch restarts the numbering", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("session", "k", () => {});
    await flush();
    fake.deliver({ sub: "s1", epoch: "e1", seq: 9, event: {} });
    fake.deliver({ sub: "s1", epoch: "e2", seq: 0, event: { kind: "snapshot" } });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k", after: { epoch: "e2", seq: 0 } }]);
  });

  it("does not resubscribe a key nobody listens to after a reconnect", async () => {
    const { fake, calls, subscriptions } = setup();
    const off = subscriptions.subscribe("session", "k", () => {});
    await flush();
    off();
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.filter(([method]) => method === "subscribe.session")).toHaveLength(1);
  });

  it("ignores events of a sub after its listeners left, and a second call of the same unsubscribe", async () => {
    const { fake, calls, subscriptions } = setup();
    const events: unknown[] = [];
    const off = subscriptions.subscribe("session", "k", (event) => events.push(event));
    await flush();
    off();
    off();
    fake.deliver({ sub: "s1", epoch: "e1", seq: 1, event: {} });
    expect(events).toEqual([]);
    expect(calls.filter(([method]) => method === "unsubscribe")).toHaveLength(1);
  });

  describe("a listener that leaves and returns before the first reply (React StrictMode)", () => {
    it("opens one subscription and delivers each event once", async () => {
      const { fake, calls, replies, subscriptions } = setup({ manual: true });
      const seen: string[] = [];
      const first = subscriptions.subscribe("session", "k", () => seen.push("first"));
      first();
      subscriptions.subscribe("session", "k", () => seen.push("second"));
      expect(calls).toEqual([["subscribe.session", { sessionId: "k" }]]);
      replies[0]?.resolve({ sub: "s1" });
      await flush();
      fake.deliver({ sub: "s1", epoch: "e1", seq: 1, event: { kind: "snapshot" } });
      expect(seen).toEqual(["second"]);
      expect(calls).toHaveLength(1);
    });

    it("releases the subscription when nobody came back before the reply", async () => {
      const { fake, calls, replies, subscriptions } = setup({ manual: true });
      const events: unknown[] = [];
      const off = subscriptions.subscribe("session", "k", (event) => events.push(event));
      off();
      replies[0]?.resolve({ sub: "s1" });
      await flush();
      expect(calls.at(-1)).toEqual(["unsubscribe", { sub: "s1" }]);
      fake.deliver({ sub: "s1", epoch: "e1", seq: 1, event: {} });
      expect(events).toEqual([]);
    });

    it("does not open again when a reply from before a reconnect fails late", async () => {
      const { fake, calls, replies, subscriptions } = setup({ manual: true });
      const first = subscriptions.subscribe("session", "k", () => {});
      fake.setState("waiting");
      fake.setState("open");
      expect(calls.filter(([method]) => method === "subscribe.session")).toHaveLength(2);
      first();
      replies[0]?.reject(new RpcError("connection_lost"));
      await flush();
      subscriptions.subscribe("session", "k", () => {});
      expect(calls.filter(([method]) => method === "subscribe.session")).toHaveLength(2);
    });
  });

  describe("frames that arrive in the same tick as the reply", () => {
    it("are delivered in order once the reply names the sub", async () => {
      const { fake, calls, replies, subscriptions } = setup({ manual: true });
      const events: unknown[] = [];
      subscriptions.subscribe("session", "k", (event) => events.push(event));
      replies[0]?.resolve({ sub: "s1" });
      fake.deliver({ sub: "s1", epoch: "e1", seq: 0, event: { kind: "snapshot" } });
      fake.deliver({ sub: "s1", epoch: "e1", seq: 1, event: { kind: "status" } });
      expect(events).toEqual([]);
      await flush();
      expect(events).toEqual([{ kind: "snapshot" }, { kind: "status" }]);
      fake.deliver({ sub: "s1", epoch: "e1", seq: 2, event: { kind: "live" } });
      expect(events).toHaveLength(3);
      fake.setState("waiting");
      fake.setState("open");
      expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k", after: { epoch: "e1", seq: 2 } }]);
    });

    it("are dropped when the connection ends before the reply, so a reused sub id starts clean", async () => {
      const { fake, replies, subscriptions } = setup({ manual: true });
      const events: unknown[] = [];
      subscriptions.subscribe("session", "k", (event) => events.push(event));
      fake.deliver({ sub: "s1", epoch: "e1", seq: 0, event: { kind: "stale" } });
      fake.setState("waiting");
      fake.setState("open");
      replies[1]?.resolve({ sub: "s1" });
      await flush();
      expect(events).toEqual([]);
    });

    it("are dropped once the reply they raced is handled and no other request is waiting", async () => {
      const { fake, replies, subscriptions } = setup({ manual: true });
      const events: unknown[] = [];
      subscriptions.subscribe("session", "a", () => {});
      fake.deliver({ sub: "old", epoch: "e1", seq: 0, event: { kind: "stale" } });
      replies[0]?.resolve({ sub: "s1" });
      await flush();
      subscriptions.subscribe("session", "b", (event) => events.push(event));
      replies[1]?.resolve({ sub: "old" });
      await flush();
      expect(events).toEqual([]);
    });

    it("are not kept for a sub that no request is waiting for", async () => {
      const { fake, subscriptions } = setup();
      const events: unknown[] = [];
      fake.deliver({ sub: "s1", epoch: "e1", seq: 0, event: { kind: "stray" } });
      subscriptions.subscribe("session", "k", (event) => events.push(event));
      await flush();
      expect(events).toEqual([]);
    });
  });

  describe("a subscribe that fails", () => {
    it("leaves the key free to subscribe again on the next connection", async () => {
      const { fake, calls, replies, subscriptions } = setup({ manual: true });
      const events: unknown[] = [];
      subscriptions.subscribe("session", "k", (event) => events.push(event));
      replies[0]?.reject(new RpcError("capacity"));
      await flush();
      fake.setState("waiting");
      fake.setState("open");
      expect(calls).toEqual([
        ["subscribe.session", { sessionId: "k" }],
        ["subscribe.session", { sessionId: "k" }],
      ]);
      replies[1]?.resolve({ sub: "s2" });
      await flush();
      fake.deliver({ sub: "s2", epoch: "e1", seq: 0, event: { kind: "snapshot" } });
      expect(events).toEqual([{ kind: "snapshot" }]);
    });
  });
});
