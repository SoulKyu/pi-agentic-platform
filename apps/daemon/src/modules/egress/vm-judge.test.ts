import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createVmJudge, type VmScope } from "./vm-judge.ts";
import { vmAddressRefused } from "./vm-address.ts";

/*
 * Mutation checks (AVM2-E8), each reverted for real in the source, the named tests run and seen to fail:
 *  - M1  port match, host names: `entryAllows(entry, host, port)` replaced by a name-only match -> "api.example.com: 443 ok, 8080 not_listed", "k8s.lan:6443 ..."
 *  - M1b port match, IP entries: `entry.ports.includes(port)` removed from the IP branch -> "ip entry with port ..."
 *  - M2  host addresses: the `hostAddresses.some(...)` guard removed -> "host address ..."
 *  - M3  pap0 subnet: the `inAgentSubnet` guard removed -> "pap0 subnet ..."
 *  - M4  private through a wildcard: `exact ? null : "private_wildcard"` replaced by `null` -> "private_wildcard ..."
 *  - M5  loopback, link-local, multicast, unspecified, CGNAT, reserved: all are the `blockedStrict` fallback
 *        (one guard; none of them has a guard of its own), removed -> every "an exact entry resolving to ..." case
 *  - M6  DNS pinning: `ips: answers` replaced by `ips: [host]` -> "pins the connection to the checked answers"
 */

const scope = (hosts: string[]): VmScope => ({
  box: { kind: "agent", id: "a1-0001" },
  launchId: "l1",
  source: "thread",
  hosts,
  trustedSources: [],
});

function setup(answers: Record<string, string[]>, hostAddresses: string[] = []) {
  const resolved: string[] = [];
  const judge = createVmJudge({
    clock: createFakeClock(),
    logger: captureLogger().logger,
    resolve: async (host) => {
      resolved.push(host);
      const found = answers[host];
      if (found === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return found;
    },
    resolveMs: 5000,
    addressRefused: vmAddressRefused,
    hostAddresses: () => hostAddresses,
  });
  const decide = (hosts: string[], host: string, port: number, kind: "connect" | "http" = "connect") =>
    judge.decide(scope(hosts), {}, kind, host, port);
  return { decide, resolved };
}

const vmOf = (d: Awaited<ReturnType<ReturnType<typeof setup>["decide"]>>) => ("vm" in d ? d.vm : undefined);

describe("the VM judge: host and port", () => {
  it("api.example.com: 443 ok, 8080 not_listed", async () => {
    const { decide } = setup({ "api.example.com": ["93.184.0.1"] });
    expect(await decide(["api.example.com"], "api.example.com", 443)).toEqual({
      ips: ["93.184.0.1"],
      host: "api.example.com",
    });
    const refused = await decide(["api.example.com"], "api.example.com", 8080);
    expect(refused).toMatchObject({ reason: "not_listed", vm: { reason: "not_listed" } });
    expect("message" in refused ? refused.message : "").toContain("api.example.com:8080");
  });

  it("k8s.lan:6443: 6443 ok, 443 not_listed", async () => {
    const { decide } = setup({ "k8s.lan": ["192.168.1.40"] });
    expect(await decide(["k8s.lan:6443"], "k8s.lan", 6443)).toMatchObject({ ips: ["192.168.1.40"] });
    expect(vmOf(await decide(["k8s.lan:6443"], "k8s.lan", 443))?.reason).toBe("not_listed");
  });

  it("ip entry with port: 192.168.1.40:6443 opens CONNECT to that IP without DNS; the IP alone does not open 6443", async () => {
    const { decide, resolved } = setup({});
    expect(await decide(["192.168.1.40:6443"], "192.168.1.40", 6443)).toEqual({
      ips: ["192.168.1.40"],
      host: "192.168.1.40",
    });
    expect(resolved).toEqual([]);
    expect(vmOf(await decide(["192.168.1.40"], "192.168.1.40", 6443))?.reason).toBe("not_listed");
    expect(await decide(["192.168.1.40"], "192.168.1.40", 443)).toMatchObject({ ips: ["192.168.1.40"] });
    expect(vmOf(await decide(["192.168.1.41:6443"], "192.168.1.40", 6443))?.reason).toBe("not_listed");
  });

  it("an IPv6 entry matches its own spelling variants", async () => {
    const { decide } = setup({});
    expect(await decide(["[fd00::5]:8443"], "[FD00:0:0:0:0:0:0:5]", 8443)).toMatchObject({
      ips: ["fd00:0:0:0:0:0:0:5"],
    });
  });

  it("an IP literal that no entry names is not_listed, and a decimal spelling is not a host", async () => {
    const { decide } = setup({});
    expect(vmOf(await decide(["api.example.com"], "93.184.0.1", 443))?.reason).toBe("not_listed");
    expect(await decide(["127.0.0.1"], "2130706433", 80)).toMatchObject({ reason: "ip_literal" });
  });

  it("a wildcard covers subdomains only, with its port", async () => {
    const { decide } = setup({ "a.example.com": ["93.184.0.1"] });
    expect(await decide(["*.example.com:8443"], "a.example.com", 8443)).toMatchObject({
      ips: ["93.184.0.1"],
    });
    expect(vmOf(await decide(["*.example.com"], "example.com", 443))?.reason).toBe("not_listed");
    expect(vmOf(await decide(["*.example.com"], "a.example.com", 8443))?.reason).toBe("not_listed");
  });

  it("plain http judges the URL's port the same way", async () => {
    const { decide } = setup({ "k8s.lan": ["192.168.1.40"] });
    expect(await decide(["k8s.lan:8080"], "k8s.lan", 8080, "http")).toMatchObject({ ips: ["192.168.1.40"] });
    expect(vmOf(await decide(["k8s.lan"], "k8s.lan", 8080, "http"))?.reason).toBe("not_listed");
  });

  it("a name that does not resolve is dns_failed, not a host-list refusal", async () => {
    const { decide } = setup({});
    expect(await decide(["gone.example.com"], "gone.example.com", 443)).toEqual({
      reason: "dns_failed",
      host: "gone.example.com",
      status: 502,
      message: "pap egress proxy: gone.example.com:443 could not be resolved (resolve).",
    });
  });

  it("pins the connection to the checked answers", async () => {
    const { decide } = setup({ "api.example.com": ["93.184.0.1", "93.184.0.2"] });
    expect(await decide(["api.example.com"], "api.example.com", 443)).toEqual({
      ips: ["93.184.0.1", "93.184.0.2"],
      host: "api.example.com",
    });
  });
});

describe("the VM judge: addresses", () => {
  it("private_wildcard: *.home.lan resolving to 192.168.1.5 is refused; the exact name is not", async () => {
    const { decide } = setup({ "nas.home.lan": ["192.168.1.5"] });
    const wild = await decide(["*.home.lan"], "nas.home.lan", 443);
    expect(vmOf(wild)).toEqual({ reason: "private_wildcard", address: "192.168.1.5" });
    expect(await decide(["nas.home.lan"], "nas.home.lan", 443)).toMatchObject({ ips: ["192.168.1.5"] });
    expect(await decide(["*.home.lan", "nas.home.lan"], "nas.home.lan", 443)).toMatchObject({
      ips: ["192.168.1.5"],
    });
  });

  it.each(["127.0.0.1", "::ffff:127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "100.64.0.1", "::1"])(
    "an exact entry resolving to %s is blocked_address",
    async (address) => {
      const { decide } = setup({ "nas.lan": [address] });
      expect(vmOf(await decide(["nas.lan"], "nas.lan", 443))).toEqual({ reason: "blocked_address", address });
    },
  );

  it("pap0 subnet: an exact entry resolving to 10.213.0.1 is blocked_address", async () => {
    const { decide } = setup({ "pap.lan": ["10.213.0.1"], "vm.lan": ["10.213.0.7"] });
    expect(vmOf(await decide(["pap.lan"], "pap.lan", 443))?.reason).toBe("blocked_address");
    expect(vmOf(await decide(["vm.lan"], "vm.lan", 443))?.reason).toBe("blocked_address");
    expect(vmOf(await decide(["10.213.0.1:7777"], "10.213.0.1", 7777))?.reason).toBe("blocked_address");
  });

  it("host address: an exact entry resolving to an address of the host is blocked_address", async () => {
    const { decide } = setup({ "me.lan": ["192.168.1.182"] }, ["192.168.1.182"]);
    expect(vmOf(await decide(["me.lan"], "me.lan", 443))).toEqual({
      reason: "blocked_address",
      address: "192.168.1.182",
    });
    expect(vmOf(await decide(["192.168.1.182:7777"], "192.168.1.182", 7777))?.reason).toBe("blocked_address");
    // a neighbour on the same LAN is not the host
    expect(await decide(["192.168.1.183:7777"], "192.168.1.183", 7777)).toMatchObject({
      ips: ["192.168.1.183"],
    });
  });

  it("one refused answer refuses the whole name, and the refusal reports the address", async () => {
    const { decide } = setup({ "mixed.lan": ["192.168.1.9", "127.0.0.1"] });
    expect(vmOf(await decide(["mixed.lan"], "mixed.lan", 443))).toEqual({
      reason: "blocked_address",
      address: "127.0.0.1",
    });
  });

  it("the refusal body names the host, the port and the reason on one line", async () => {
    const { decide } = setup({ "nas.lan": ["127.0.0.1"] });
    const refused = await decide(["nas.lan"], "nas.lan", 443);
    const message = "message" in refused ? (refused.message ?? "") : "";
    expect(message).toContain("nas.lan:443");
    expect(message).toContain("blocked_address");
    expect(message).not.toContain("\n");
  });
});

describe("vmAddressRefused", () => {
  const none: string[] = [];
  it.each([
    ["10.0.0.5", true, null],
    ["10.0.0.5", false, "private_wildcard"],
    ["172.16.4.4", false, "private_wildcard"],
    ["172.32.0.1", false, null],
    ["192.168.0.1", false, "private_wildcard"],
    ["fd12::1", true, null],
    ["fd12::1", false, "private_wildcard"],
    ["::ffff:192.168.1.5", false, "private_wildcard"],
    ["::ffff:192.168.1.5", true, null],
    ["93.184.0.1", false, null],
    ["fe80::1", true, "blocked_address"],
    ["ff02::1", true, "blocked_address"],
    ["::", true, "blocked_address"],
    ["10.213.0.200", true, "blocked_address"],
    ["::ffff:10.213.0.1", true, "blocked_address"],
    ["192.0.2.1", true, "blocked_address"],
    ["not an address", true, "blocked_address"],
  ] as const)("%s (exact %s) -> %s", (ip, exact, expected) => {
    expect(vmAddressRefused(ip, exact, none)).toBe(expected);
  });

  it("refuses ... loopback, link-local, multicast, unspecified in every spelling, exact or not", () => {
    for (const ip of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "169.254.169.254", "224.0.0.251"])
      for (const exact of [true, false]) expect(vmAddressRefused(ip, exact, none)).toBe("blocked_address");
  });

  it("the host's own addresses are refused in any spelling, even private ones", () => {
    expect(vmAddressRefused("192.168.1.182", true, ["192.168.1.182"])).toBe("blocked_address");
    expect(vmAddressRefused("::ffff:192.168.1.182", true, ["192.168.1.182"])).toBe("blocked_address");
    expect(vmAddressRefused("fd00::5", true, ["FD00:0:0:0:0:0:0:5"])).toBe("blocked_address");
    expect(vmAddressRefused("192.168.1.183", true, ["192.168.1.182"])).toBeNull();
  });
});
