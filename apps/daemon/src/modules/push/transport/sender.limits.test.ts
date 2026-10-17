import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { startFakePushService, type FakePushService } from "../testing/fake-push-service.ts";
import { drainCapped, sendOnce } from "./sender.ts";

let fake: FakePushService;
beforeEach(async () => {
  fake = await startFakePushService();
});
afterEach(() => fake.close());

describe("sendOnce limits", () => {
  const HANG = {
    body: Buffer.from("x"),
    headers: {},
    allowLoopback: true,
    allowAddress: () => false,
  };

  it("a request that outlives its total limit is cut on the Clock, even when the outbox signal never fires", async () => {
    fake.hangNext();
    const clock = createFakeClock();
    const pending = sendOnce({
      ...HANG,
      href: `${fake.url}/x`,
      signal: new AbortController().signal,
      clock,
      totalMs: 5_000,
    });
    await fake.received(1);
    await clock.advance(4_999);
    await clock.advance(1);
    expect(await pending).toEqual({ error: "timeout" });
    await fake.settled();
  });

  it("a silent socket is cut at its idle limit", async () => {
    fake.hangNext();
    const result = await sendOnce({
      ...HANG,
      href: `${fake.url}/x`,
      signal: new AbortController().signal,
      clock: createFakeClock(),
      idleMs: 30,
    });
    expect(result).toEqual({ error: "timeout" });
    await fake.settled();
  });

  it("drainCapped destroys a response exactly when more than the cap has arrived", () => {
    const stream = new PassThrough();
    drainCapped(stream, 8 * 1024);
    for (let chunk = 1; chunk <= 8; chunk += 1) {
      stream.emit("data", Buffer.alloc(1024));
      expect(stream.destroyed, `after chunk ${chunk}`).toBe(false);
    }
    stream.emit("data", Buffer.alloc(1024));
    expect(stream.destroyed, "the 9th chunk crosses 8 KiB").toBe(true);
  });

  it("sendOnce: a synchronous throw of request() (a bad header value) is a network outcome", async () => {
    const result = await sendOnce({
      href: `${fake.url}/x`,
      body: Buffer.from("x"),
      headers: { "x-bad": "a\nb" },
      clock: createFakeClock(),
      signal: new AbortController().signal,
      allowLoopback: true,
      allowAddress: () => false,
    });
    expect(result).toEqual({ error: "network" });
  });
});
