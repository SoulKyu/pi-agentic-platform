import type { LookupAddress } from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { startFakePushService, type FakePushService } from "../testing/fake-push-service.ts";
import { sendOnce, type Resolver, type SendResult } from "./sender.ts";

/*
 * Socket-level guard tests use loopback addresses only (W5-R50, W6-R12): 127.0.0.1 is the one the rule allows and the
 * fake listens on; 127.0.0.2 and 127.0.0.3 stand in for "private". A broken guard therefore can only reach loopback,
 * never a real private or public address. The table of real ranges is a pure test in kernel/net/address-push.test.ts.
 */
let fake: FakePushService;
beforeEach(async () => {
  fake = await startFakePushService({ tls: true });
});
afterEach(() => fake.close());

const answer = (address: string): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 });
const resolverOf =
  (...addresses: string[]): Resolver =>
  (_host, _options, callback) =>
    callback(null, addresses.map(answer));
const onlyLoopback = (ip: string) => ip === "127.0.0.1";
const ARGS = { body: Buffer.from("x"), headers: {}, allowLoopback: false, allowAddress: onlyLoopback };
const portOf = () => new URL(fake.url).port;
const call = (href: string, over: Partial<Parameters<typeof sendOnce>[0]> = {}): Promise<SendResult> =>
  sendOnce({ ...ARGS, href, signal: new AbortController().signal, clock: createFakeClock(), ...over });

describe("the address guard", () => {
  it("refuses a name whose only answer is not allowed, and an empty answer", async () => {
    for (const answers of [["127.0.0.2"], ["::1"], []])
      expect(
        await call(`https://pap.example.net:${portOf()}/x`, { resolve: resolverOf(...answers) }),
        answers.join(),
      ).toEqual({ error: "address" });
  });

  it("one refused answer refuses the name, whatever its place among the answers", async () => {
    for (const answers of [
      ["127.0.0.1", "127.0.0.2"],
      ["127.0.0.2", "127.0.0.1"],
      ["127.0.0.1", "127.0.0.1", "127.0.0.3"],
    ]) {
      const result = await call(`https://pap.example.net:${portOf()}/x`, {
        resolve: resolverOf(...answers),
      });
      // a guard that let it through would have connected to the fake on 127.0.0.1 and ended in a TLS failure
      expect(result, answers.join(" ")).toEqual({ error: "address" });
    }
    expect(fake.connections(), "the allowed answer was never dialled either").toBe(0);
  });

  it("a name that passes connects to exactly the address that was checked, not to a second resolution", async () => {
    const resolve = vi.fn<Resolver>((_host, _options, callback) =>
      callback(null, [answer(resolve.mock.calls.length === 1 ? "127.0.0.1" : "127.0.0.2")]),
    );
    const result = await call(`https://pap.example.net:${portOf()}/x`, { resolve });
    expect(result, "the certificate is self-signed, so the handshake fails after the connect").toEqual({
      error: "network",
    });
    expect(fake.connections(), "the socket reached the fake on 127.0.0.1").toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe("pap.example.net");
  });

  it("a resolver error is a network outcome, not a throw", async () => {
    const resolve: Resolver = (_host, _options, callback) =>
      callback(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), []);
    expect(await call("https://pap.example.net/x", { resolve })).toEqual({ error: "network" });
  });

  it("an IP literal never reaches the lookup, so it is judged by the same rule", async () => {
    const resolve = vi.fn<Resolver>();
    for (const href of [`https://127.0.0.3:${portOf()}/x`, "https://[::1]:1/x", "https://127.0.0.2/x"])
      expect(await call(href, { resolve }), href).toEqual({ error: "address" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("only https goes out; http only to 127.0.0.1 with the loopback switch; anything else is an outcome", async () => {
    const hrefs = [
      "http://pap.example.net/x",
      `http://127.0.0.1:${portOf()}/x`,
      "ftp://pap.example.net/x",
      "javascript:alert(1)",
      "not a url",
      "",
    ];
    for (const href of hrefs) expect(await call(href), href).toEqual({ error: "address" });
    expect(await call("http://localhost:1/x", { allowLoopback: true })).toEqual({ error: "address" });
    expect(fake.connections(), "the fake on 127.0.0.1 was offered as http and never dialled").toBe(0);
  });
});
