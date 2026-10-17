import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { startFakePushService, type FakePushService } from "../testing/fake-push-service.ts";
import { sendOnce } from "./sender.ts";

let fake: FakePushService;
beforeEach(async () => {
  fake = await startFakePushService({ tls: true });
});
afterEach(() => fake.close());

describe("TLS verification", () => {
  it("verification-is-on: a self-signed push service is refused and no request body reaches it", async () => {
    const result = await sendOnce({
      href: `${fake.url}/push/x`,
      body: Buffer.from("SECRET-PLAINTEXT"),
      headers: {},
      signal: new AbortController().signal,
      clock: createFakeClock(),
      allowLoopback: false,
      allowAddress: () => true, // the address rule is not under test; the certificate is
    });
    expect(result).toEqual({ error: "network" });
    await fake.settled();
    expect(fake.connections()).toBe(1);
    expect(fake.requests).toHaveLength(0);
  });
});
