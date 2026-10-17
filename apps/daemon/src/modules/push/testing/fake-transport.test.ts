import { describe, expect, it } from "vitest";
import type { SubscriptionTarget } from "../index.ts";
import { createFakeTransport } from "./fake-transport.ts";

const TARGET: SubscriptionTarget = {
  id: "s1",
  endpoint: "https://push.example.net/x",
  p256dh: "p",
  auth: "a",
  credentialId: "c1",
  locale: "en",
};
const OPTS = { ttlSeconds: 60, urgency: "high", topic: "t" } as const;
const send = (
  transport: ReturnType<typeof createFakeTransport>,
  text: string,
  signal = new AbortController().signal,
) => transport.send(TARGET, new TextEncoder().encode(text), OPTS, signal);

describe("createFakeTransport", () => {
  it("answers ok and records the call with the plaintext, the options and the same target object", async () => {
    const transport = createFakeTransport();
    expect(await send(transport, "hello")).toEqual({ kind: "ok" });
    expect(transport.sent).toHaveLength(1);
    const [call] = transport.sent;
    expect(call?.target).toBe(TARGET);
    expect(new TextDecoder().decode(call?.plaintext)).toBe("hello");
    expect(call?.opts).toEqual(OPTS);
  });

  it("returns the queued outcomes in order, then ok again", async () => {
    const transport = createFakeTransport();
    transport.next({ kind: "retry", afterMs: 5 });
    transport.next({ kind: "gone" });
    expect(await send(transport, "1")).toEqual({ kind: "retry", afterMs: 5 });
    expect(await send(transport, "2")).toEqual({ kind: "gone" });
    expect(await send(transport, "3")).toEqual({ kind: "ok" });
    expect(transport.sent).toHaveLength(3);
  });

  it("reports the status the test set", () => {
    const transport = createFakeTransport();
    expect(transport.status().on).toBe(true);
    transport.setStatus(false);
    expect(transport.status()).toEqual({ on: false, reason: null, publicKey: null });
    transport.setStatus(true);
    expect(transport.status().publicKey).not.toBeNull();
  });

  it("holds the next send on a promise the test releases, and records it at once", async () => {
    const transport = createFakeTransport();
    const hold = transport.hold();
    let settled = false;
    const pending = send(transport, "held").then((outcome) => {
      settled = true;
      return outcome;
    });
    await Promise.resolve();
    expect(transport.sent).toHaveLength(1);
    expect(settled).toBe(false);
    hold.release();
    expect(await pending).toEqual({ kind: "ok" });
    expect(await send(transport, "free")).toEqual({ kind: "ok" });
  });

  it("answers retry to a held send whose signal aborts", async () => {
    const transport = createFakeTransport();
    transport.hold();
    const controller = new AbortController();
    const pending = send(transport, "held", controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: "retry" });
  });
});
