import { expect, it } from "vitest";
import { judgeUrl } from "./egress.ts";

// Decision 119 (C1): the list of a VM agent holds `host:port`, IP and `[ipv6]:port` entries; the URL stage matches them.
const list = ["k8s.lan:6443", "192.168.1.40", "[fd00::5]:8080", "*.docs.example.org", "example.com"];
it.each([
  ["https://k8s.lan:6443/api", true],
  ["https://k8s.lan/api", false],
  ["https://k8s.lan:6444/api", false],
  ["http://192.168.1.40/x", true],
  ["https://192.168.1.40/x", true],
  ["http://192.168.1.40:6443/x", false],
  ["http://192.168.1.41/x", false],
  ["http://[fd00::5]:8080/x", true],
  ["http://[fd00:0::5]:8080/x", true],
  ["http://[fd00::5]/x", false],
  ["http://[fd00::6]:8080/x", false],
  ["https://api.docs.example.org/x", true],
  ["https://example.com:8443/x", true],
  ["http://127.0.0.1/x", false],
])("judges %s against a list with ports and IPs → %s", (url, ok) => {
  expect(judgeUrl(url, list).ok).toBe(ok);
});

it("keeps the reasons: an unlisted IP is an IP address, an unlisted name is named", () => {
  expect(judgeUrl("http://10.0.0.1/", list)).toEqual({ ok: false, why: "IP address" });
  expect(judgeUrl("https://evil.test/", list)).toEqual({ ok: false, why: "web host not allowed: evil.test" });
});

it("never matches an invalid entry", () => {
  expect(judgeUrl("https://k8s.lan/", ["k8s.lan:0", ":443", "[::::]"]).ok).toBe(false);
});
