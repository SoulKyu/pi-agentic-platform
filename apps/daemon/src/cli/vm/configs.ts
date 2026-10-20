import { cniConflist } from "@pap/contracts";
import { CliError } from "../open-home.ts";

/** First line of the one host-global file pap writes; uninstall removes that file only while it still starts with it. */
export const KATA_MARKER = "# written by pap vm setup";

export const PATHS = Object.freeze({
  opt: "/opt/pap-vm",
  kata: "/opt/kata",
  etc: "/etc/pap-vm",
  state: "/var/lib/pap-vm",
  run: "/run/pap-vm",
  kataConfig: "/etc/kata-containers/runtime-rs/configuration.toml",
  kataShim: "/opt/kata/runtime-rs/bin/containerd-shim-kata-v2",
  kataShipped: "share/defaults/kata-containers/runtime-rs/configuration-clh-runtime-rs.toml",
  units: "/etc/systemd/system",
  shimWrapper: "containerd-shim-kata-clh-v2",
});

/** Kata keys pap overrides (R29). Each must exist, uncommented, in the shipped file. */
export const KATA_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["default_memory", "256"],
  ["default_vcpus", "1"],
  ["static_sandbox_resource_mgmt", "true"],
];

/** The shipped runtime-rs CLH config with pap's three values. A key the file lacks stops setup naming it. */
export function kataConfig(shipped: string): string {
  let text = shipped;
  for (const [key, value] of KATA_KEYS) {
    const line = new RegExp(`^${key}[ \\t]*=.*$`, "m");
    if (!line.test(text)) throw new CliError(`the shipped Kata config has no ${key}: setup stopped`);
    text = text.replace(line, `${key} = ${value}`);
  }
  return `${KATA_MARKER}\n${text}`;
}

export const containerdToml = (): string =>
  [
    "version = 2",
    `root = "${PATHS.state}/containerd"`,
    `state = "${PATHS.run}/containerd"`,
    "[grpc]",
    `  address = "${PATHS.run}/containerd.sock"`,
    "",
  ].join("\n");

export const buildkitdToml = (): string =>
  [
    `root = "${PATHS.state}/buildkit"`,
    "[grpc]",
    `  address = ["unix://${PATHS.run}/buildkit.sock"]`,
    "[worker.oci]",
    "  enabled = false",
    "[worker.containerd]",
    "  enabled = true",
    `  address = "${PATHS.run}/containerd.sock"`,
    '  namespace = "pap"',
    "",
  ].join("\n");

export const shimWrapper = (): string => `#!/bin/sh\nexec ${PATHS.kataShim} "$@"\n`;

export const vmdConfig = (user: { uid: number; gid: number; home: string }): string =>
  `${JSON.stringify({ papUid: user.uid, papGid: user.gid, papHome: user.home }, null, 2)}\n`;

/**
 * The contract's conflist with host-local's reservations kept under /run (T20a): its default folder (/var/lib/cni) outlives a
 * reboot while no VM does, and a reservation left by a failed start made that address "not available" for good.
 */
export function conflist(): string {
  const document = JSON.parse(cniConflist()) as { plugins: Array<{ ipam: Record<string, unknown> }> };
  for (const plugin of document.plugins) plugin.ipam.dataDir = `${PATHS.run}/cni-ipam`;
  return `${JSON.stringify(document, null, 2)}\n`;
}
