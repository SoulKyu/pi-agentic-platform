import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { ADDED, NEVER_DIALLED } from "../../kernel/net/testing/address-vectors.ts";
import { createGoogleFetcher } from "./google-fetch.ts";
import type { Resolver } from "./guarded-get.ts";

const resolverOf =
  (...addresses: string[]): Resolver =>
  (_host, _options, callback) =>
    callback(
      null,
      addresses.map((address): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
const fetcherFor = (...addresses: string[]) =>
  createGoogleFetcher({ clock: createFakeClock(), resolve: resolverOf(...addresses) });

describe("the Google fetcher: where it may go", () => {
  it("accepts only the two Google hosts over https on the default port, with no credentials", async () => {
    const fetcher = fetcherFor("10.0.0.1"); // an address that is refused: a url that passes the host rule ends in "address"
    expect(await fetcher("https://fonts.googleapis.com/css2?family=Inter", 1024)).toEqual({
      ok: false,
      error: "address",
    });
    expect(await fetcher("https://fonts.gstatic.com/s/inter/v1/x.woff2", 1024)).toEqual({
      ok: false,
      error: "address",
    });
    for (const url of [
      "http://fonts.googleapis.com/css2?family=Inter",
      "https://fonts.googleapis.com:8443/css2?family=Inter",
      "https://user@fonts.googleapis.com/css2?family=Inter",
      "https://fonts.googleapis.com.evil.example/css2?family=Inter",
      "https://evil.example/css2?family=Inter",
      "https://fonts.googleapis.com/other",
      "https://fonts.gstatic.com/css2?family=Inter",
      "https://fonts.googleapis.com/s/x.woff2",
      "https://127.0.0.1/s/x.woff2",
      "not a url",
    ])
      expect(await fetcher(url, 1024), url).toEqual({ ok: false, error: "host" });
  });

  it("runs every resolved address through blockedStrict: private, loopback, metadata and the added ranges", async () => {
    for (const ip of [...NEVER_DIALLED, ...ADDED])
      expect(await fetcherFor(ip)("https://fonts.gstatic.com/s/x.woff2", 1024), ip).toEqual({
        ok: false,
        error: "address",
      });
    // one private answer among public ones refuses the name
    expect(await fetcherFor("8.8.8.8", "10.0.0.1")("https://fonts.gstatic.com/s/x.woff2", 1024)).toEqual({
      ok: false,
      error: "address",
    });
  });
});
