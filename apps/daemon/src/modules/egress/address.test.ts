import { describe, expect, it } from "vitest";
import { blockedAddress } from "./address.ts";

const BLOCKED = [
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.182",
  "169.254.169.254",
  "100.64.0.1",
  "100.127.255.255",
  "0.0.0.0",
  "198.18.0.1",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "fd12::1",
  "fe80::1",
  "fe80::1%eth0",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::FFFF:7F00:1",
  "0:0:0:0:0:ffff:7f00:1",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "::7f00:1",
  "::ffff:0:127.0.0.1",
  "::ffff:0:7f00:1",
  "::ffff:0:10.1.2.3",
  "0:0:0:0:ffff:0:a9fe:a9fe",
  "fec0::1",
  "2002:7f00:1::1",
  "64:ff9b::1",
  "64:ff9b:1::1",
  "not-an-ip",
  "127.1",
  "",
];
const ALLOWED = [
  "172.32.0.1",
  "100.128.0.1",
  "198.51.100.1",
  "203.0.113.7",
  "2606:4700::1111",
  "::ffff:198.51.100.1",
  "::ffff:0:198.51.100.1",
  "2002:0101:0101::1",
];

describe("blockedAddress", () => {
  it.each(BLOCKED)("refuses %s", (ip) => {
    expect(blockedAddress(ip)).toBe(true);
  });

  it.each(ALLOWED)("lets %s through", (ip) => {
    expect(blockedAddress(ip)).toBe(false);
  });
});
