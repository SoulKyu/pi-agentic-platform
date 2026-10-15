import { createServer, request, type Server } from "node:http";
import type { LookupAddress } from "node:dns";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  FEED_MAX_REDIRECTS,
  FeedAddressError,
  feedUrlRefusal,
  guardedLookup,
  isPublicAddress,
  type Resolver,
  redirectTarget,
} from "./net-guard.ts";

const PUBLIC = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "2606:4700:4700::1111",
  "::ffff:8.8.8.8",
  "172.32.0.1",
  "172.15.255.255",
];
const REFUSED = [
  "127.0.0.1",
  "127.255.255.254",
  "10.0.0.1",
  "10.255.255.255",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.182",
  "169.254.169.254",
  "100.64.0.1",
  "100.127.255.255",
  "0.0.0.0",
  "224.0.0.1",
  "239.255.255.250",
  "255.255.255.255",
  "240.0.0.1",
  "198.18.0.1",
  "198.19.255.255",
  "192.0.2.7",
  "198.51.100.9",
  "203.0.113.9",
  "::1",
  "::",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "::ffff:169.254.169.254",
  "fe80::1",
  "fd00::1",
  "fc00::1",
  "ff02::1",
  "64:ff9b::7f00:1",
  "2002:7f00:1::",
  "2001:db8::1",
  "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  "::127.0.0.1",
  "::7f00:1",
  "::a9fe:a9fe",
  "::ffff:0:7f00:1",
  "::ffff:0:a9fe:a9fe",
  "example.com",
  "",
  "not an address",
];

describe("isPublicAddress (M10R74)", () => {
  it.each(PUBLIC)("lets %s through", (address) => expect(isPublicAddress(address)).toBe(true));
  it.each(REFUSED)("refuses %j", (address) => expect(isPublicAddress(address)).toBe(false));

  it("keeps the IPv6 rules away from IPv4 and IPv4-mapped addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "9.9.9.9", "::ffff:8.8.8.8", "::ffff:1.1.1.1"])
      expect(isPublicAddress(address)).toBe(true);
  });
});

describe("feedUrlRefusal", () => {
  const refusal = (text: string) => feedUrlRefusal(new URL(text));
  it("accepts a public https address and a name", () => {
    expect(refusal("https://example.com/feed.xml")).toBeNull();
    expect(refusal("https://8.8.8.8/feed")).toBeNull();
    expect(refusal("https://[2606:4700:4700::1111]/")).toBeNull();
  });
  it("refuses other schemes", () => {
    expect(refusal("http://example.com/")).toBe("not_https");
    expect(refusal("file:///etc/passwd")).toBe("not_https");
    expect(refusal("ftp://example.com/")).toBe("not_https");
  });
  it("refuses credentials", () => {
    expect(refusal("https://user:pw@example.com/")).toBe("credentials");
    expect(refusal("https://user@example.com/")).toBe("credentials");
  });
  it.each([
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f.1/",
    "https://[::1]/",
    "https://[::ffff:7f00:1]/",
    "https://[::127.0.0.1]/",
    "https://[::ffff:0:7f00:1]/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::a9fe:a9fe]/",
    "https://10.1.2.3/",
  ])("refuses the literal %s", (text) => expect(refusal(text)).toBe("address"));
});

describe("redirectTarget", () => {
  const from = new URL("https://example.com/a/feed");
  it.each([301, 302, 303, 307, 308])("follows a %i", (status) => {
    expect(redirectTarget(from, status, "https://example.org/x")).toEqual({
      url: new URL("https://example.org/x"),
    });
  });
  it("is null for an answer that is not a redirect", () => {
    for (const status of [200, 204, 300, 304, 305, 404, 500])
      expect(redirectTarget(from, status, "/x")).toBeNull();
  });
  it("resolves a relative Location against the current address", () => {
    expect(redirectTarget(from, 302, "/b")).toEqual({ url: new URL("https://example.com/b") });
  });
  it("judges the target like the first address", () => {
    expect(redirectTarget(from, 302, "http://example.com/")).toEqual({ refused: "not_https" });
    expect(redirectTarget(from, 302, "https://10.0.0.1/")).toEqual({ refused: "address" });
    expect(redirectTarget(from, 302, "https://[::127.0.0.1]/")).toEqual({ refused: "address" });
    expect(redirectTarget(from, 302, "https://u:p@example.org/")).toEqual({ refused: "credentials" });
  });
  it("refuses a missing, unparsable or huge Location", () => {
    expect(redirectTarget(from, 302, undefined)).toEqual({ refused: "bad_redirect" });
    expect(redirectTarget(from, 302, "https://")).toEqual({ refused: "bad_redirect" });
    expect(redirectTarget(from, 302, `/${"a".repeat(3000)}`)).toEqual({ refused: "bad_redirect" });
  });
  it("allows at most five redirects", () => expect(FEED_MAX_REDIRECTS).toBe(5));
});

const answer =
  (...addresses: string[]): Resolver =>
  (_name, _options, callback) =>
    callback(
      null,
      addresses.map((address): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 })),
    );

function lookupOnce(
  lookup: ReturnType<typeof guardedLookup>,
  options: { all?: boolean; family?: number } = {},
): Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }> {
  return new Promise((resolve) =>
    lookup("feed.test", options, (error, address, family) => resolve({ error, address, family })),
  );
}

describe("guardedLookup", () => {
  it("answers the first public address in the single form", async () => {
    const result = await lookupOnce(guardedLookup(answer("8.8.8.8", "1.1.1.1")));
    expect(result).toEqual({ error: null, address: "8.8.8.8", family: 4 });
  });
  it("answers every public address in the `all` form", async () => {
    const result = await lookupOnce(guardedLookup(answer("8.8.8.8", "2606:4700:4700::1111")), { all: true });
    expect(result.error).toBeNull();
    expect(result.address).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });
  it("honours the requested family", async () => {
    const result = await lookupOnce(guardedLookup(answer("8.8.8.8", "2606:4700:4700::1111")), { family: 6 });
    expect(result).toEqual({ error: null, address: "2606:4700:4700::1111", family: 6 });
  });
  it("refuses a name when one answer is not public, whatever its position", async () => {
    for (const set of [
      ["8.8.8.8", "10.0.0.5"],
      ["10.0.0.5", "8.8.8.8"],
    ])
      for (const all of [true, false]) {
        const result = await lookupOnce(guardedLookup(answer(...set)), { all });
        expect(result.error).toBeInstanceOf(FeedAddressError);
      }
  });
  it("refuses a name that answers only a loopback address", async () => {
    const result = await lookupOnce(guardedLookup(answer("127.0.0.1")));
    expect(result.error).toBeInstanceOf(FeedAddressError);
    expect(result.error?.code).toBe("EFEEDADDR");
  });
  it("refuses a name with no usable answer", async () => {
    expect((await lookupOnce(guardedLookup(answer()))).error).toBeInstanceOf(FeedAddressError);
  });
  it("passes a resolver error on", async () => {
    const failing: Resolver = (_name, _options, callback) =>
      callback(Object.assign(new Error("nope"), { code: "ENOTFOUND" }), []);
    const result = await lookupOnce(guardedLookup(failing));
    expect(result.error?.code).toBe("ENOTFOUND");
  });
  it("uses the `allowed` function it is given (a test seam), not the default", async () => {
    const result = await lookupOnce(guardedLookup(answer("127.0.0.1"), (address) => address === "127.0.0.1"));
    expect(result).toEqual({ error: null, address: "127.0.0.1", family: 4 });
  });
});

describe("a real request through the guard", () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  it("never connects to a name that resolves to a loopback address", async () => {
    let connections = 0;
    server = createServer((_req, res) => res.end("secret"));
    server.on("connection", () => void connections++);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const call = request(
        { host: "feed.test", port, agent: false, lookup: guardedLookup(answer("127.0.0.1")) },
        () => resolve(new Error("connected") as NodeJS.ErrnoException),
      );
      call.on("error", resolve);
      call.end();
    });
    expect(error.code).toBe("EFEEDADDR");
    expect(connections).toBe(0);
  });

  it("connects when the seam allows the address", async () => {
    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const body = await new Promise<string>((resolve, reject) => {
      const call = request(
        { host: "feed.test", port, agent: false, lookup: guardedLookup(answer("127.0.0.1"), () => true) },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => void (text += chunk.toString()));
          res.on("end", () => resolve(text));
        },
      );
      call.on("error", reject);
      call.end();
    });
    expect(body).toBe("ok");
  });
});
