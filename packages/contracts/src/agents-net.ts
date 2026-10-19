import { AGENT_NET } from "./agents-vm.ts";

export type AgentNet = typeof AGENT_NET;

/** One VM's bridge port, MAC and address, which pap-vmd adds to `ports` at `vm.start` (from the CNI result) and removes at stop. */
export interface VmPort {
  readonly port: string;
  readonly mac: string;
  readonly ip: string;
}
const PORT_NAME = /^[A-Za-z0-9_.-]{1,15}$/;
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const IPV4 = /^10\.213\.0\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/;

/**
 * Spec §4, decision 107 Q4, owner Q13 (R22), RT-03, RT-04, RT-21. The inet table: a VM reaches the gateway and the relay on
 * the bridge address and nothing else; those two ports answer nobody but the bridge (not `lo`, not Docker, not a LAN host
 * that routes to 10.213.0.1); nothing is forwarded to or from the bridge. The bridge table: a frame entering `pap0` from a
 * VM port must carry that port's own MAC and IPv4 address (ARP included); IPv6 is dropped; VM to VM is dropped. Loading it
 * empties `ports`: pap-vmd re-adds the elements of the VMs that run (T16a).
 */
export function agentNetRuleset(net: AgentNet = AGENT_NET): string {
  const ports = `{ ${net.gatewayPort}, ${net.relayPort} }`;
  return `${[
    "table inet pap_agents",
    "delete table inet pap_agents",
    "table inet pap_agents {",
    "  chain input {",
    "    type filter hook input priority filter; policy accept;",
    `    ip daddr ${net.host} tcp dport ${ports} iifname != "${net.bridge}" counter drop`,
    `    iifname "${net.bridge}" ip saddr ${net.subnet} ip daddr ${net.host} tcp dport ${ports} accept`,
    `    iifname "${net.bridge}" counter drop`,
    "  }",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    `    iifname "${net.bridge}" counter drop`,
    `    oifname "${net.bridge}" counter drop`,
    "  }",
    "}",
    "table bridge pap_agents",
    "delete table bridge pap_agents",
    "table bridge pap_agents {",
    "  set ports {",
    "    type ifname . ether_addr . ipv4_addr",
    "  }",
    "  chain prerouting {",
    "    type filter hook prerouting priority -300; policy accept;",
    `    meta ibrname != "${net.bridge}" accept`,
    "    ether type ip6 counter drop",
    "    ether type arp iifname . ether saddr . arp saddr ip @ports iifname . arp saddr ether . arp saddr ip @ports accept",
    "    ether type ip iifname . ether saddr . ip saddr @ports accept",
    "    counter drop",
    "  }",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    `    meta ibrname "${net.bridge}" counter drop`,
    "  }",
    "}",
  ].join("\n")}\n`;
}

/** The set element of one VM (added at start, deleted at stop), from checked values only. */
export function portElement(vm: VmPort): string {
  if (!PORT_NAME.test(vm.port) || !MAC.test(vm.mac) || !IPV4.test(vm.ip)) throw new RangeError("vm port");
  return `{ "${vm.port}" . ${vm.mac} . ${vm.ip} }`;
}

export function cniConflist(net: AgentNet = AGENT_NET): string {
  return JSON.stringify(
    {
      cniVersion: "1.0.0",
      name: net.network,
      plugins: [
        {
          type: "bridge",
          bridge: net.bridge,
          // RT-21: a gateway bridge turns on host-wide IPv4 forwarding; the address is set by pap-vmd.service's ExecStartPre.
          isGateway: false,
          ipMasq: false,
          hairpinMode: false,
          ipam: { type: "host-local", ranges: [[{ subnet: net.subnet, gateway: net.host }]], routes: [] },
        },
      ],
    },
    null,
    2,
  );
}
