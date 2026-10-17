import { describe, expect, it } from "vitest";
import { endpointRefusal, hostRules, PUSH_SERVICE_HOSTS } from "./endpoint.ts";

const check = (raw: string, extra: readonly string[] = [], loopbackForTests = false) =>
  endpointRefusal(raw, { hosts: hostRules(extra), loopbackForTests });

describe("endpointRefusal refusals", () => {
  const refused: readonly [string, string][] = [
    ["http://fcm.googleapis.com/x", "not_https"],
    ["ftp://fcm.googleapis.com/x", "not_https"],
    ["https://user:pw@fcm.googleapis.com/x", "credentials"],
    ["https://fcm.googleapis.com:8443/x", "port"],
    ["https://fcm.googleapis.com:80/x", "port"],
    ["https://fcm.googleapis.com/x#a", "fragment"],
    ["https://fcm.googleapis.com/x#", "fragment"],
    ["https://127.0.0.1/", "ip_literal"],
    ["https://0x7f.1/", "ip_literal"],
    ["https://2130706433/", "ip_literal"],
    ["https://017700000001/", "ip_literal"],
    ["https://[::1]/", "ip_literal"],
    ["https://[::ffff:7f00:1]/", "ip_literal"],
    ["https://169.254.169.254/", "ip_literal"],
    ["https://localhost/", "host"],
    ["https://fcm.googleapis.com./x", "host"],
    ["https://a..push.apple.com/x", "host"],
    ["https://.push.apple.com/x", "host"],
    ["https://fcm.googleapis.com.evil.example/x", "host_not_allowed"],
    ["https://evil.example/fcm.googleapis.com", "host_not_allowed"],
    ["https://fcm.googleapis.com@evil.example/", "credentials"],
    ["https://evilpush.apple.com/", "host_not_allowed"],
    ["https://push.apple.com/", "host_not_allowed"],
    ["https://evil.example\\@fcm.googleapis.com/", "host_not_allowed"],
    ["https://evil.example%2Efcm.googleapis.com/", "host_not_allowed"],
    ["https://fcm.googleapis.com%2Eevil.example/", "host_not_allowed"],
    ["https://fcm.xn--googlepis-5yh.com/x", "host_not_allowed"],
    ["https://web.push.xn--pple-43d.com/x", "host_not_allowed"],
    ["https://fcm.googleapis.com\uff0eevil.example/x", "host_not_allowed"],
    ["https://xn--fcm-googleapis-xyz.com/", "malformed"],
    ["https://xn--web-push-apple-4la.push.apple.com.evil.example/", "malformed"],
    ["not a url", "malformed"],
    ["", "malformed"],
    [`https://fcm.googleapis.com/${"a".repeat(2049 - "https://fcm.googleapis.com/".length)}`, "too_long"],
  ];
  it.each(refused)("refuses %s as %s", (raw, reason) => {
    expect(check(raw)).toEqual({ ok: false, reason });
  });

  it("accepts exactly 2048 characters", () => {
    const prefix = "https://fcm.googleapis.com/";
    const raw = prefix + "a".repeat(2048 - prefix.length);
    expect(raw).toHaveLength(2048);
    expect(check(raw).ok).toBe(true);
  });
});

describe("endpointRefusal canonicalisation", () => {
  const canonical: readonly [string, string][] = [
    ["https://fcm.googleapis.com\\@evil.example/", "https://fcm.googleapis.com/@evil.example/"],
    ["https://fcm%2Egoogleapis.com/x", "https://fcm.googleapis.com/x"],
    ["https://FCM.GoogleAPIs.com/x", "https://fcm.googleapis.com/x"],
    ["https://fcm.googleapis.com:443/x", "https://fcm.googleapis.com/x"],
    ["https://WEB.PUSH.APPLE.COM/abc", "https://web.push.apple.com/abc"],
  ];
  it.each(canonical)("%s stores %s", (raw, href) => {
    const out = check(raw);
    expect(out).toMatchObject({ ok: true, href });
    if (out.ok) expect(out.host).toBe(new URL(href).hostname);
  });
});

describe("endpointRefusal accepts", () => {
  it.each([
    "https://web.push.apple.com/abc",
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://a.push.services.mozilla.com/wpush/v2/abc",
    "https://x.notify.windows.com/?token=abc",
  ])("%s", (raw) => {
    expect(check(raw).ok).toBe(true);
  });
});

describe("hostRules", () => {
  it("keeps the built-in list and adds exact names only", () => {
    expect(hostRules([])).toEqual(PUSH_SERVICE_HOSTS);
    expect(check("https://push.example.net/x", ["push.example.net"]).ok).toBe(true);
    expect(check("https://a.push.example.net/x", ["push.example.net"])).toEqual({
      ok: false,
      reason: "host_not_allowed",
    });
    expect(check("https://push.example.net/x")).toEqual({ ok: false, reason: "host_not_allowed" });
    expect(check("https://fcm.googleapis.com/x", ["push.example.net"]).ok).toBe(true);
  });

  it("an extra host still passes the shape rules", () => {
    expect(check("https://10.0.0.1/x", ["10.0.0.1"])).toEqual({ ok: false, reason: "ip_literal" });
    expect(check("https://localhost/x", ["localhost"])).toEqual({ ok: false, reason: "host" });
  });

  it("an empty extra list never opens the endpoint check", () => {
    expect(check("https://evil.example/x", [])).toEqual({ ok: false, reason: "host_not_allowed" });
  });
});

describe("the canonical href is bounded too", () => {
  it("refuses a short raw text whose canonical href is longer than 2048", () => {
    // each "e acute" becomes %C3%A9: 400 of them are 400 characters raw and 2400 canonical
    const raw = `https://fcm.googleapis.com/${"\u00e9".repeat(400)}`;
    expect(raw.length).toBeLessThan(2048);
    expect(check(raw)).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("loopbackForTests", () => {
  it("replaces the protocol check only: credentials and a fragment are still refused", () => {
    expect(check("http://user:pw@127.0.0.1:4555/", [], true)).toEqual({ ok: false, reason: "credentials" });
    expect(check("http://127.0.0.1:4555/x#a", [], true)).toEqual({ ok: false, reason: "fragment" });
    expect(check("http://127.0.0.1:4555/x#", [], true)).toEqual({ ok: false, reason: "fragment" });
  });
  it("lets only http://127.0.0.1 through", () => {
    expect(check("http://127.0.0.1:4555/push", [], true)).toMatchObject({ ok: true, host: "127.0.0.1" });
    expect(check("http://127.0.0.2:4555/", [], true)).toEqual({ ok: false, reason: "not_https" });
    expect(check("http://localhost:4555/", [], true)).toEqual({ ok: false, reason: "not_https" });
    expect(check("https://127.0.0.1/", [], true)).toEqual({ ok: false, reason: "ip_literal" });
    expect(check("http://[::1]:4555/", [], true)).toEqual({ ok: false, reason: "not_https" });
  });
  it("is off by default", () => {
    expect(check("http://127.0.0.1:4555/push")).toEqual({ ok: false, reason: "not_https" });
  });
});
