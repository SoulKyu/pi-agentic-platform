import { describe, expect, it } from "vitest";
import { UNIT_FILES, UNIT_NAMES } from "./units.ts";

/* Mutant: an ExecStart outside /opt/pap-vm (e.g. /usr/bin/node). Killed by "every ExecStart is under /opt/pap-vm". */
describe("units", () => {
  it("every ExecStart is under /opt/pap-vm", () => {
    for (const name of UNIT_NAMES) {
      const starts = UNIT_FILES[name]()
        .split("\n")
        .filter((l) => l.startsWith("ExecStart="));
      expect(starts, name).toHaveLength(1);
      expect(starts[0]?.startsWith("ExecStart=/opt/pap-vm/"), name).toBe(true);
    }
  });

  it("pap-vmd.service carries the hardening, the paths and the bridge steps", () => {
    const text = UNIT_FILES["pap-vmd.service"]();
    for (const line of [
      "ProtectHome=read-only",
      "PrivateTmp=yes",
      "NoNewPrivileges=yes",
      "ProtectSystem=strict",
      "ExecStart=/opt/pap-vm/node/bin/node /opt/pap-vm/vmd/dist/main.js",
      "ExecStartPre=+/usr/sbin/sysctl -w net.ipv6.conf.pap0.disable_ipv6=1",
      "ExecStartPre=+/usr/sbin/nft -f /etc/pap-vm/agents.nft",
      "ExecStartPre=+/usr/sbin/ip addr replace 10.213.0.1/24 dev pap0",
    ])
      expect(text).toContain(`${line}\n`);
    expect(text).toContain("ip link add pap0 type bridge");
    const rw = /^ReadWritePaths=(.*)$/m.exec(text)?.[1]?.split(" ");
    expect(rw).toEqual([
      "/var/lib/pap-vm",
      "/run/pap-vm",
      "-/run/netns",
      "-/run/kata-containers",
      "-/var/lib/cni",
    ]);
  });

  it("pap's containerd finds the shim wrapper first", () => {
    expect(UNIT_FILES["pap-vm-containerd.service"]()).toMatch(/^Environment=PATH=\/opt\/pap-vm\/bin:/m);
  });
});
