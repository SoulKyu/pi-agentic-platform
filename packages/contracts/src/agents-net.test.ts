import { describe, expect, it } from "vitest";
import { agentNetRuleset, cniConflist, portElement, VM_IPV4 } from "./agents-net.ts";

const EXPECTED = `table inet pap_agents
delete table inet pap_agents
table inet pap_agents {
  chain input {
    type filter hook input priority filter; policy accept;
    ip daddr 10.213.0.1 tcp dport { 7841, 7842 } iifname != "pap0" counter drop
    iifname "pap0" ip saddr 10.213.0.0/24 ip daddr 10.213.0.1 tcp dport { 7841, 7842 } accept
    iifname "pap0" counter drop
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "pap0" counter drop
    oifname "pap0" counter drop
  }
}
table bridge pap_agents
delete table bridge pap_agents
table bridge pap_agents {
  set ports {
    type ifname . ether_addr . ipv4_addr
  }
  chain prerouting {
    type filter hook prerouting priority -300; policy accept;
    meta ibrname != "pap0" accept
    ether type ip6 counter drop
    ether type arp iifname . ether saddr . arp saddr ip @ports iifname . arp saddr ether . arp saddr ip @ports accept
    ether type ip iifname . ether saddr . ip saddr @ports accept
    counter drop
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    meta ibrname "pap0" counter drop
  }
}
`;

describe("agentNetRuleset", () => {
  it("is the fixed text", () => {
    expect(agentNetRuleset()).toBe(EXPECTED);
  });

  // Mutant: drop the `iifname !=` line. Killed by the fixed-text case above and by this one: the line answers the two
  // ports to nobody but the bridge (not lo, not Docker, not a LAN host routing to 10.213.0.1).
  it("keeps the line that drops the two ports for anything but the bridge", () => {
    expect(agentNetRuleset()).toContain(
      'ip daddr 10.213.0.1 tcp dport { 7841, 7842 } iifname != "pap0" counter drop',
    );
  });

  // Mutant: drop the ARP lookup. Killed here: a gratuitous ARP could re-point the host's entry for another VM.
  it("checks the ARP sender against the ports set", () => {
    expect(agentNetRuleset()).toContain("ether type arp iifname . ether saddr . arp saddr ip @ports");
  });

  // Mutant: drop the IPv6 drop. Killed here: the guard covers IPv4 only.
  it("drops IPv6 on the bridge", () => {
    expect(agentNetRuleset()).toContain("ether type ip6 counter drop");
  });
});

describe("portElement", () => {
  const vm = { port: "veth1a2b", mac: "02:00:00:aa:bb:cc", ip: "10.213.0.7" };

  it("renders a set element from checked values", () => {
    expect(portElement(vm)).toBe('{ "veth1a2b" . 02:00:00:aa:bb:cc . 10.213.0.7 }');
  });

  it("refuses a port name with a semicolon, the bridge address, .255, a foreign address and a malformed MAC", () => {
    const bad = [
      { port: "a;b" },
      { port: "a".repeat(16) },
      { ip: "10.213.0.1" },
      { ip: "10.213.0.255" },
      { ip: "10.213.0.0" },
      { ip: "10.213.1.7" },
      { ip: "192.168.0.7" },
      { mac: "02:00:00:AA:BB:CC" },
      { mac: "02:00:00:aa:bb" },
    ];
    for (const patch of bad)
      expect(() => portElement({ ...vm, ...patch }), JSON.stringify(patch)).toThrow(RangeError);
  });
});

describe("VM_IPV4", () => {
  it("is 10.213.0.2 to 10.213.0.254", () => {
    for (const ip of ["10.213.0.2", "10.213.0.9", "10.213.0.99", "10.213.0.200", "10.213.0.254"]) {
      expect(VM_IPV4.test(ip), ip).toBe(true);
    }
    for (const ip of [
      "10.213.0.0",
      "10.213.0.1",
      "10.213.0.255",
      "10.213.0.256",
      "10.213.0.999",
      "10.213.1.5",
    ]) {
      expect(VM_IPV4.test(ip), ip).toBe(false);
    }
  });
});

describe("cniConflist", () => {
  it("never makes the bridge a gateway, masquerades or routes", () => {
    const plugin = JSON.parse(cniConflist()).plugins[0];
    expect(plugin).toMatchObject({ type: "bridge", bridge: "pap0", isGateway: false, ipMasq: false });
    expect(plugin.ipam.routes).toEqual([]);
    expect(plugin.ipam.ranges).toEqual([[{ subnet: "10.213.0.0/24", gateway: "10.213.0.1" }]]);
  });
});
