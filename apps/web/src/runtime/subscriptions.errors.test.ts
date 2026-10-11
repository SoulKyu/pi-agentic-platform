import { describe, expect, it, vi } from "vitest";
import { RpcError } from "./rpc.ts";
import { flush, subscriptionBed as setup } from "./testing.ts";

describe("subscription failures", () => {
  describe("onError", () => {
    it.each(["not_found", "capacity", "internal", "forbidden"] as const)(
      "reports %s to every listener that asked",
      async (code) => {
        const { replies, subscriptions } = setup({ manual: true });
        const seen: string[] = [];
        subscriptions.subscribe(
          "session",
          "k",
          () => {},
          (c) => seen.push(`a:${c}`),
        );
        subscriptions.subscribe(
          "session",
          "k",
          () => {},
          (c) => seen.push(`b:${c}`),
        );
        subscriptions.subscribe("session", "k", () => {});
        replies[0]?.reject(new RpcError(code));
        await flush();
        expect(seen).toEqual([`a:${code}`, `b:${code}`]);
      },
    );

    it("reports a failure that is not an RpcError as internal", async () => {
      const { replies, subscriptions } = setup({ manual: true });
      const seen: string[] = [];
      subscriptions.subscribe(
        "session",
        "k",
        () => {},
        (code) => seen.push(code),
      );
      replies[0]?.reject(new TypeError("boom"));
      await flush();
      expect(seen).toEqual(["internal"]);
    });

    it.each(["connection_lost", "offline"] as const)(
      "stays silent for %s: the reconnect retries it",
      async (code) => {
        const { fake, calls, replies, subscriptions } = setup({ manual: true });
        const seen: string[] = [];
        subscriptions.subscribe(
          "session",
          "k",
          () => {},
          (c) => seen.push(c),
        );
        replies[0]?.reject(new RpcError(code));
        await flush();
        expect(seen).toEqual([]);
        fake.setState("waiting");
        fake.setState("open");
        expect(calls.filter(([method]) => method === "subscribe.session")).toHaveLength(2);
      },
    );

    it("ignores the failure of a request that a reconnect replaced", async () => {
      const { fake, replies, subscriptions } = setup({ manual: true });
      const seen: string[] = [];
      subscriptions.subscribe(
        "session",
        "k",
        () => {},
        (c) => seen.push(c),
      );
      fake.setState("waiting");
      fake.setState("open");
      replies[0]?.reject(new RpcError("not_found"));
      await flush();
      expect(seen).toEqual([]);
    });

    it("lets a listener that joins after a failure try again", async () => {
      const { calls, replies, subscriptions } = setup({ manual: true });
      subscriptions.subscribe(
        "session",
        "k",
        () => {},
        () => {},
      );
      replies[0]?.reject(new RpcError("capacity"));
      await flush();
      const events: unknown[] = [];
      subscriptions.subscribe("session", "k", (event) => events.push(event));
      expect(calls.filter(([method]) => method === "subscribe.session")).toHaveLength(2);
      replies[1]?.resolve({ sub: "s2" });
      await flush();
      expect(events).toEqual([]);
    });

    it("does not let a throwing onError stop the others", async () => {
      const { replies, subscriptions } = setup({ manual: true });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const seen: string[] = [];
      subscriptions.subscribe(
        "session",
        "k",
        () => {},
        () => {
          throw new Error("ui broke");
        },
      );
      subscriptions.subscribe(
        "session",
        "k",
        () => {},
        (code) => seen.push(code),
      );
      replies[0]?.reject(new RpcError("not_found"));
      await flush();
      expect(seen).toEqual(["not_found"]);
      expect(errors).toHaveBeenCalledTimes(1);
      errors.mockRestore();
    });
  });

  it("isolates listeners: one that throws neither stops the others nor the cursor", async () => {
    const { fake, calls, subscriptions } = setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    subscriptions.subscribe("session", "k", () => {
      throw new Error("reducer broke");
    });
    subscriptions.subscribe("session", "k", () => seen.push("second"));
    await flush();
    fake.deliver({ sub: "s1", epoch: "e1", seq: 5, event: {} });
    expect(seen).toEqual(["second"]);
    expect(errors).toHaveBeenCalledTimes(1);
    fake.setState("waiting");
    fake.setState("open");
    expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k", after: { epoch: "e1", seq: 5 } }]);
    errors.mockRestore();
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
