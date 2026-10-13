import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../kernel/ids.ts";
import { ipKey, sessionKey } from "./throttle-keys.ts";

describe("sessionKey", () => {
  it("is the hash of the session's id hash, cut to 32 hex characters, never the cookie", () => {
    const cookie = "cookie-value-abcdefghijklmnopqrstuvwxyz0123456789";
    const key = sessionKey(cookie);
    expect(key).toBe(`session:${sha256Hex(sha256Hex(cookie)).slice(0, 32)}`);
    expect(key).toMatch(/^session:[0-9a-f]{32}$/);
    expect(key).not.toContain(cookie);
    expect(key).not.toContain(sha256Hex(cookie).slice(0, 32));
  });

  it("gives two cookies two keys", () => {
    expect(sessionKey("one")).not.toBe(sessionKey("two"));
  });
});

describe("ipKey", () => {
  it("keeps an IPv4 address and unwraps an IPv4-mapped one", () => {
    expect(ipKey("203.0.113.9")).toBe("ip:203.0.113.9");
    expect(ipKey("::ffff:203.0.113.9")).toBe("ip:203.0.113.9");
    expect(ipKey("::ffff:cb00:7109")).toBe("ip:203.0.113.9");
  });

  it("gives an IPv6 address the key of its /64", () => {
    expect(ipKey("2001:db8:1:2:3:4:5:6")).toBe("ip:2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2::9")).toBe("ip:2001:db8:1:2::/64");
    expect(ipKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("ip:2001:db8:1:2::/64");
    expect(ipKey("2001:db8::1")).toBe("ip:2001:db8:0:0::/64");
    expect(ipKey("2001:db8:1:3::9")).not.toBe(ipKey("2001:db8:1:2::9"));
    expect(ipKey("fe80::1%eth0")).toBe("ip:fe80:0:0:0::/64");
    expect(ipKey("::1")).toBe("ip:0:0:0:0::/64");
  });

  it("leaves what is not an address as it is, cut to a bounded length", () => {
    expect(ipKey("unknown")).toBe("ip:unknown");
    expect(ipKey("x".repeat(500))).toBe(`ip:${"x".repeat(64)}`);
  });
});
