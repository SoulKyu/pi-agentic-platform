import { describe, expect, it } from "vitest";
import { isHostName } from "./host-name.ts";

describe("isHostName", () => {
  it.each(["fcm.googleapis.com", "a.b.example", "xn--pple-43d.com", "web.push.apple.com", "a-b.c-d.io"])(
    "accepts %s",
    (host) => expect(isHostName(host)).toBe(true),
  );
  it.each([
    "",
    "localhost",
    "127.0.0.1",
    "::1",
    "0x7f.1",
    "1.2.3.4.5",
    "a..b.com",
    ".a.com",
    "a.com.",
    "-a.com",
    "a-.com",
    "a_b.com",
    "a b.com",
    "a.com/x",
    "a.com:443",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(130)}com`,
    "a.123",
  ])("refuses %j", (host) => expect(isHostName(host)).toBe(false));
});
