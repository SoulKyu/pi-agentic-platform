import { describe, expect, it } from "vitest";
import { RpcError } from "./rpc.ts";
import { flush, subscriptionBed as setup } from "./testing.ts";

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

  describe("a subscribe made while the connection announces it is open", () => {
    it("sends two requests, delivers once, and releases the sub of the one that lost", async () => {
      const { fake, calls, replies, hooks, subscriptions } = setup({ manual: true, state: "connecting" });
      const seen: string[] = [];
      subscriptions.subscribe("session", "k", () => seen.push("a"));
      hooks.onOpen = () => {
        subscriptions.subscribe("session", "k", () => seen.push("b"));
      };
      fake.setState("open");
      expect(calls.filter(([method]) => method === "subscribe.session")).toHaveLength(2);
      replies[0]?.resolve({ sub: "s1" });
      replies[1]?.resolve({ sub: "s2" });
      await flush();
      expect(calls.filter(([method]) => method === "unsubscribe")).toEqual([["unsubscribe", { sub: "s1" }]]);
      fake.deliver({ sub: "s1", epoch: "e1", seq: 0, event: {} });
      fake.deliver({ sub: "s2", epoch: "e1", seq: 0, event: {} });
      expect(seen).toEqual(["a", "b"]);
    });

    it("does not release the sub of a request that belongs to a connection that ended", async () => {
      const { fake, calls, replies, subscriptions } = setup({ manual: true });
      subscriptions.subscribe("session", "k", () => {});
      fake.setState("waiting");
      fake.setState("open");
      replies[0]?.resolve({ sub: "s1" });
      await flush();
      expect(calls.filter(([method]) => method === "unsubscribe")).toEqual([]);
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

    it("are capped at 256: a reply that never comes cannot grow the buffer without bound", async () => {
      const { fake, replies, subscriptions } = setup({ manual: true });
      const events: unknown[] = [];
      subscriptions.subscribe("session", "k", (event) => events.push(event));
      for (let seq = 0; seq < 300; seq++) fake.deliver({ sub: "s1", epoch: "e1", seq, event: seq });
      replies[0]?.resolve({ sub: "s1" });
      await flush();
      expect(events).toHaveLength(256);
      expect(events[0]).toBe(0);
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

  describe("streams and resync (R125)", () => {
    it("a session and the shell with the same key are two subscriptions", async () => {
      const { fake, calls, subscriptions } = setup();
      const a: unknown[] = [];
      const b: unknown[] = [];
      subscriptions.subscribe("session", "me", (event) => a.push(event));
      subscriptions.subscribe("shell", "me", (event) => b.push(event));
      await flush();
      expect(calls).toEqual([
        ["subscribe.session", { sessionId: "me" }],
        ["subscribe.shell", {}],
      ]);
      fake.deliver({ sub: "s1", epoch: "e1", seq: 0, event: "for-session" });
      fake.deliver({ sub: "s2", epoch: "e1", seq: 0, event: "for-shell" });
      expect(a).toEqual(["for-session"]);
      expect(b).toEqual(["for-shell"]);
    });

    it("the shell stream resumes from its cursor", async () => {
      const { fake, calls, subscriptions } = setup();
      subscriptions.subscribe("shell", "me", () => {});
      await flush();
      fake.deliver({ sub: "s1", epoch: "e", seq: 4, event: {} });
      fake.setState("waiting");
      fake.setState("open");
      await flush();
      expect(calls.at(-1)).toEqual(["subscribe.shell", { after: { epoch: "e", seq: 4 } }]);
    });

    it("resync asks again without a cursor and frees the old sub", async () => {
      const { fake, calls, replies, subscriptions } = setup({ manual: true });
      const events: unknown[] = [];
      subscriptions.subscribe("session", "x", (event) => events.push(event));
      replies[0]?.resolve({ sub: "s1" });
      await flush();
      fake.deliver({ sub: "s1", epoch: "e1", seq: 4, event: "old" });
      subscriptions.resync("session", "x");
      expect(calls.slice(1)).toEqual([
        ["unsubscribe", { sub: "s1" }],
        ["subscribe.session", { sessionId: "x" }],
      ]);
      // A frame of the released sub is ignored; the answer to the new request serves the listener.
      fake.deliver({ sub: "s1", epoch: "e1", seq: 5, event: "late" });
      replies[2]?.resolve({ sub: "s3" });
      await flush();
      fake.deliver({ sub: "s3", epoch: "e2", seq: 0, event: "snapshot" });
      expect(events).toEqual(["old", "snapshot"]);
    });

    it("resync releases the answer to a request made before it", async () => {
      const { calls, replies, subscriptions } = setup({ manual: true });
      subscriptions.subscribe("shell", "me", () => {});
      subscriptions.resync("shell", "me");
      expect(calls.filter(([method]) => method === "subscribe.shell")).toHaveLength(2);
      replies[0]?.resolve({ sub: "stale" });
      replies[1]?.resolve({ sub: "fresh" });
      await flush();
      expect(calls.filter(([method]) => method === "unsubscribe")).toEqual([
        ["unsubscribe", { sub: "stale" }],
      ]);
    });

    it("resync does nothing without listeners", async () => {
      const { calls, subscriptions } = setup();
      subscriptions.resync("session", "never");
      const off = subscriptions.subscribe("session", "x", () => {});
      await flush();
      off();
      const before = calls.length;
      subscriptions.resync("session", "x");
      expect(calls).toHaveLength(before);
    });

    it("resync while offline makes the reconnect ask without a cursor", async () => {
      const { fake, calls, subscriptions } = setup();
      subscriptions.subscribe("shell", "me", () => {});
      await flush();
      fake.deliver({ sub: "s1", epoch: "e", seq: 4, event: {} });
      fake.setState("waiting");
      const before = calls.length;
      subscriptions.resync("shell", "me");
      expect(calls).toHaveLength(before);
      fake.setState("open");
      await flush();
      expect(calls.at(-1)).toEqual(["subscribe.shell", {}]);
      expect(calls.filter(([method]) => method === "subscribe.shell")).toHaveLength(2);
    });
  });
});
