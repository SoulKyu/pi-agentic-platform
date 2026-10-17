import { describe, expect, it } from "vitest";
import { blockedAddress } from "./address.ts";
import { blockedForPush } from "./address-push.ts";

const ADDED = [
  "2001::1",
  "2001:0:1234::1",
  "2001:db8::1",
  "2001:db8:ffff::1",
  "100::1",
  "100::ffff:ffff:ffff:ffff",
  "192.0.2.1",
  "198.51.100.1",
  "203.0.113.200",
  "192.88.99.1",
  "::ffff:198.51.100.1",
  "::ffff:192.0.2.9",
  "::ffff:c000:209",
  "::ffff:0:203.0.113.5",
  "::FFFF:C058:6301",
  "2002:c633:6401::1",
];

/** Boundaries just outside each added range, plus ordinary public and blocked addresses (20 in all). */
const SHARED = [
  "172.32.0.1",
  "100.128.0.1",
  "198.17.255.255",
  "198.52.0.1",
  "203.0.114.1",
  "192.0.3.1",
  "192.88.100.1",
  "2606:4700::1111",
  "2002:0101:0101::1",
  "2001:1::1",
  "2001:db9::1",
  "100:0:0:1::1",
  "127.0.0.1",
  "10.1.2.3",
  "192.168.1.182",
  "::1",
  "fe80::1",
  "::ffff:127.0.0.1",
  "not-an-ip",
  "",
];

describe("blockedForPush", () => {
  it.each(ADDED)(
    "refuses %s, which the proxy's check lets through where it is a range of this task",
    (ip) => {
      expect(blockedForPush(ip)).toBe(true);
    },
  );

  it("is stricter than blockedAddress on the ranges it adds", () => {
    const loosened = ADDED.filter((ip) => !blockedAddress(ip));
    expect(loosened.length).toBeGreaterThan(10);
  });

  it("agrees with blockedAddress everywhere else", () => {
    expect(SHARED).toHaveLength(20);
    for (const ip of SHARED) expect([ip, blockedForPush(ip)]).toEqual([ip, blockedAddress(ip)]);
  });
});

/** What the push sender's default check refuses, by value: the sender tests never dial any of these (W6-R12). */
const NEVER_DIALLED = [
  "10.0.0.1",
  "127.0.0.1",
  "127.0.0.2",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.0.1",
  "::1",
  "fd00::1",
  "fe80::1",
  "::ffff:10.0.0.1",
  "::ffff:127.0.0.1",
  "198.51.100.7",
  "2001:db8::1",
];

describe("the default check of the push sender", () => {
  it.each(NEVER_DIALLED)("refuses %s", (ip) => {
    expect(blockedForPush(ip)).toBe(true);
  });
});
