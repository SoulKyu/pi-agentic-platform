import { describe, expect, it } from "vitest";
import { cookieNeedsSecure, readCookie } from "./cookies.ts";

describe("cookie Secure policy", () => {
  it("is omitted only for plain-http loopback hosts", () => {
    for (const url of [
      "http://localhost:7777/",
      "http://127.0.0.1:7777/",
      "http://[::1]:7777/",
      "http://LOCALHOST:7777/",
    ]) {
      expect(cookieNeedsSecure(url), url).toBe(false);
    }
  });

  it("is set for https and for every non-loopback host", () => {
    for (const url of [
      "https://localhost:7777/",
      "https://127.0.0.1/",
      "https://[::1]:7777/",
      "https://pap.example.net/",
      "http://pap.example.net:7777/",
      "http://192.168.1.20:7777/",
      "http://127.0.0.2:7777/",
      "http://localhost.evil.example/",
      "http://localhost./",
    ]) {
      expect(cookieNeedsSecure(url), url).toBe(true);
    }
  });

  it("fails closed on a URL it cannot read", () => {
    expect(cookieNeedsSecure("not a url")).toBe(true);
  });
});

describe("readCookie", () => {
  it("finds a cookie by exact name among others", () => {
    expect(readCookie("a=1; pap_session=abc; b=2", "pap_session")).toBe("abc");
    expect(readCookie("xpap_session=no; pap_session=yes", "pap_session")).toBe("yes");
    expect(readCookie("pap_session=a=b", "pap_session")).toBe("a=b");
  });

  it("returns undefined when there is none", () => {
    expect(readCookie(undefined, "pap_session")).toBeUndefined();
    expect(readCookie("", "pap_session")).toBeUndefined();
    expect(readCookie("pap_session2=x; =y", "pap_session")).toBeUndefined();
  });
});
