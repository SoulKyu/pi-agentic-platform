import { describe, expect, it } from "vitest";
import { cookieNeedsSecure, readCookie, sessionCookieAttributes } from "./cookies.ts";

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

describe("session cookie attributes", () => {
  it("are HttpOnly, SameSite=Strict, path / and never carry a Domain", () => {
    const attributes = sessionCookieAttributes("http://localhost:7777/auth/login", false);
    expect(attributes).toEqual({ httpOnly: true, secure: false, sameSite: "Strict", path: "/" });
  });

  it("stay Secure on a plain-http loopback request when the public origin is https (R24b)", () => {
    const publicSecure = cookieNeedsSecure("https://pap.example.net");
    expect(publicSecure).toBe(true);
    expect(sessionCookieAttributes("http://127.0.0.1:7777/auth/login", publicSecure).secure).toBe(true);
    expect(
      sessionCookieAttributes("http://127.0.0.1:7777/auth/login", cookieNeedsSecure("http://localhost:7777"))
        .secure,
    ).toBe(false);
  });

  it("stay Secure on a plain-http loopback request when the public origin is a plain-http non-loopback name", () => {
    const publicSecure = cookieNeedsSecure("http://pap.lan:7777");
    expect(publicSecure).toBe(true);
    expect(sessionCookieAttributes("http://127.0.0.1:7777/auth/login", publicSecure).secure).toBe(true);
  });

  it("drop Secure on any plain-http request only when --insecure-http allows it", () => {
    expect(sessionCookieAttributes("http://192.168.1.20:7777/auth/login", true).secure).toBe(true);
    expect(sessionCookieAttributes("http://192.168.1.20:7777/auth/login", true, true).secure).toBe(false);
    expect(sessionCookieAttributes("http://pap.lan:7777/auth/login", true, true).secure).toBe(false);
    expect(sessionCookieAttributes("https://192.168.1.20:7777/auth/login", true, true).secure).toBe(true);
    expect(sessionCookieAttributes("not a url", true, true).secure).toBe(true);
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
