import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../kernel/ids.ts";
import { sessionKey } from "./throttle-keys.ts";

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
