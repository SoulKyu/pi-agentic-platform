import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestBrowser,
  startFakePushService,
  type FakePushService,
} from "../testing/fake-push-service.ts";
import { openHttpsBed, TEST_HOST, type HttpsBed } from "../testing/https-bed.ts";
import { hostRules } from "./endpoint.ts";
import type { Resolver } from "./sender.ts";

/*
 * A stored endpoint was valid when it was stored; the rules may have changed since (an extra host removed, a
 * restore from a backup, a row written by an older pap). The sender judges again with the rules of now, because
 * Node's net.connect skips the lookup hook for an IP literal (T4 carry).
 */
const OPTS = { ttlSeconds: 60, urgency: "normal" as const, topic: "topic-1" };
let fake: FakePushService;
let bed: HttpsBed;
let resolve: ReturnType<typeof vi.fn<Resolver>>;
beforeEach(async () => {
  fake = await startFakePushService();
  resolve = vi.fn<Resolver>((_host, _options, callback) => callback(null, []));
  bed = openHttpsBed({ hosts: hostRules([TEST_HOST]), lookup: resolve });
});
afterEach(async () => {
  bed.close();
  await fake.close();
});

describe("the endpoint is judged again at send time", () => {
  it.each([
    ["an IP literal", "https://127.0.0.1/x"],
    ["an IPv6 literal", "https://[::1]/x"],
    ["a host nobody listed (an extra host that was removed)", "https://other.example.net/x"],
    ["a port other than 443", "https://push.example.net:8443/x"],
    ["credentials", "https://user:pass@push.example.net/x"],
    ["a fragment", "https://push.example.net/x#frag"],
    ["plain http off loopback", "http://push.example.net/x"],
  ])("refused-at-send: %s", async (_name, endpoint) => {
    const outcome = await bed.transport.send(
      createTestBrowser().target(endpoint),
      Buffer.from("x"),
      OPTS,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ kind: "refused", reason: "endpoint" });
    expect(resolve, "no lookup, so no connection").not.toHaveBeenCalled();
  });

  it("a listed host passes the check and reaches the guarded lookup", async () => {
    const outcome = await bed.transport.send(
      createTestBrowser().target("https://push.example.net/x"),
      Buffer.from("x"),
      OPTS,
      new AbortController().signal,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "refused", reason: "address" }); // the resolver answered nothing
  });

  it.each([[["127.0.0.1"]], [["127.0.0.2"]], [["127.0.0.1", "127.0.0.2"]], [["::1"]]])(
    "the default address check refuses a listed host that resolves to %j (no allowAddress given)",
    async (answers) => {
      resolve.mockImplementationOnce((_host, _options, callback) =>
        callback(
          null,
          answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
        ),
      );
      const outcome = await bed.transport.send(
        createTestBrowser().target(`https://${TEST_HOST}/x`),
        Buffer.from("x"),
        OPTS,
        new AbortController().signal,
      );
      // a check that let loopback through would reach port 443 of this machine and end in a retry
      expect(outcome).toEqual({ kind: "refused", reason: "address" });
      expect(resolve).toHaveBeenCalledTimes(1);
    },
  );
});
