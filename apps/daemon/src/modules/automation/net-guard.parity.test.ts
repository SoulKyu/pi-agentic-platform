import { describe, expect, it } from "vitest";
import { blockedAddress } from "../../kernel/net/address.ts";
import { blockedStrict } from "../../kernel/net/address-strict.ts";
import { ADDED, NEVER_DIALLED, SHARED } from "../../kernel/net/testing/address-vectors.ts";
import { isPublicAddress } from "./net-guard.ts";

const RANGES_OF_THE_FEED_LIST = [
  "0.0.0.1",
  "100.64.0.1",
  "192.0.0.9",
  "198.18.0.1",
  "198.19.255.255",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "::",
  "::1.2.3.4",
  "::ffff:0:1.2.3.4",
  "64:ff9b::192.0.2.1",
  "64:ff9b:1::1",
  "fc00::1",
  "fec0::1",
  "ff02::1",
  "2002:c000:0201::",
];

const VECTORS = [...ADDED, ...SHARED, ...NEVER_DIALLED, ...RANGES_OF_THE_FEED_LIST];

/** Ledger (M13 B4, M13-C5): refused by blockedStrict and allowed by the feed guard: the ranges the feed list lacks. */
const DIFFERENT_STRICT_ONLY = [
  "3fff::1",
  "3fff:fff:ffff::1",
  "2001:2::1",
  "2001:10::1",
  "2001:1f::1",
  "5f00::1",
];
/**
 * Ledger (M13 B4): allowed by blockedStrict and refused by the feed guard. Both embed a public IPv4 address (the feed
 * guard refuses all of 2002::/16 and all of ::ffff:0:0:0/96); neither reaches a reserved IPv4 address.
 */
const DIFFERENT_FEED_ONLY = ["2002:0101:0101::1", "::ffff:0:1.2.3.4"];

describe("the three address predicates over the shared vectors (M13R46)", () => {
  const strictOnly = (ip: string): boolean => blockedStrict(ip) && isPublicAddress(ip);
  const feedOnly = (ip: string): boolean => !blockedStrict(ip) && !isPublicAddress(ip);
  const unique = [...new Set(VECTORS)];

  it("pins every difference between blockedStrict and the feed guard's list (a failure prints it)", () => {
    expect(unique.filter(strictOnly)).toEqual(DIFFERENT_STRICT_ONLY);
    expect(unique.filter(feedOnly)).toEqual(DIFFERENT_FEED_ONLY);
  });

  it("blockedStrict is never weaker than blockedAddress", () => {
    for (const ip of unique) if (blockedAddress(ip)) expect([ip, blockedStrict(ip)]).toEqual([ip, true]);
  });
});
