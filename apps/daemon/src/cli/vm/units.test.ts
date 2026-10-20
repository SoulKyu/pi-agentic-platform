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
    // T20a: nerdctl locks and makes folders in its network config path at every `run` (the real stack failed "read-only file system").
    // Mutant: /etc/pap-vm/cni dropped from ReadWritePaths -> every `vm.start` fails.
    const rw = /^ReadWritePaths=(.*)$/m.exec(text)?.[1]?.split(" ");
    expect(rw).toEqual([
      "/var/lib/pap-vm",
      "/run/pap-vm",
      "/etc/pap-vm/cni",
      "-/run/netns",
      "-/run/kata-containers",
      "-/var/lib/cni",
    ]);
  });

  // T20a: `After=` waits for containerd to be started, not ready (about 2 s on a fresh state). With systemd's 100 ms restart delay the
  // five tries of the start limit were over before the socket answered, and pap-vmd stayed failed after every setup.
  // Mutant: RestartSec dropped -> this case fails.
  it("pap-vmd.service waits between restarts for longer than containerd takes to answer", () => {
    expect(UNIT_FILES["pap-vmd.service"]()).toContain("Restart=on-failure\nRestartSec=3\n");
  });

  it("containerd and buildkitd run from /opt/pap-vm/bin", () => {
    expect(UNIT_FILES["pap-vm-containerd.service"]()).toContain(
      "ExecStart=/opt/pap-vm/bin/containerd --config",
    );
    expect(UNIT_FILES["pap-vm-buildkit.service"]()).toContain("ExecStart=/opt/pap-vm/bin/buildkitd --config");
  });

  it("pap's containerd finds the shim wrapper first", () => {
    expect(UNIT_FILES["pap-vm-containerd.service"]()).toMatch(/^Environment=PATH=\/opt\/pap-vm\/bin:/m);
  });
});
