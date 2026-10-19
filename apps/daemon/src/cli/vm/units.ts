import { AGENT_NET } from "@pap/contracts";
import { PATHS } from "./configs.ts";

export const UNIT_NAMES = [
  "pap-vm-containerd.service",
  "pap-vm-buildkit.service",
  "pap-vmd.service",
] as const;

const PATH_ENV = `${PATHS.opt}/bin:${PATHS.kata}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const INSTALL = ["[Install]", "WantedBy=multi-user.target"];
const RUNTIME_DIR = ["RuntimeDirectory=pap-vm", "RuntimeDirectoryPreserve=yes"];

const lines = (parts: string[]): string => `${parts.join("\n")}\n`;

export const containerdUnit = (): string =>
  lines([
    "[Unit]",
    "Description=pap VM containerd (its own socket, root and state)",
    "After=network.target",
    "",
    "[Service]",
    `Environment=PATH=${PATH_ENV}`,
    ...RUNTIME_DIR,
    `ExecStart=${PATHS.opt}/bin/containerd --config ${PATHS.etc}/containerd.toml`,
    "Delegate=yes",
    "KillMode=process",
    "Restart=on-failure",
    "LimitNOFILE=1048576",
    "",
    ...INSTALL,
  ]);

export const buildkitUnit = (): string =>
  lines([
    "[Unit]",
    "Description=pap VM BuildKit (containerd worker, namespace pap)",
    "After=pap-vm-containerd.service",
    "Requires=pap-vm-containerd.service",
    "",
    "[Service]",
    `Environment=PATH=${PATH_ENV}`,
    ...RUNTIME_DIR,
    `ExecStart=${PATHS.opt}/bin/buildkitd --config ${PATHS.etc}/buildkitd.toml`,
    "Restart=on-failure",
    "",
    ...INSTALL,
  ]);

/** `+` runs a pre-step outside the unit's sandbox: the bridge, the sysctl and the ruleset are host network state. */
const bridgeSteps = (): string[] => {
  const { bridge, host } = AGENT_NET;
  return [
    `ExecStartPre=+/bin/sh -c '/usr/sbin/ip link show ${bridge} >/dev/null 2>&1 || /usr/sbin/ip link add ${bridge} type bridge'`,
    `ExecStartPre=+/usr/sbin/ip addr replace ${host}/24 dev ${bridge}`,
    `ExecStartPre=+/usr/sbin/ip link set ${bridge} up`,
    `ExecStartPre=+/usr/sbin/sysctl -w net.ipv6.conf.${bridge}.disable_ipv6=1`,
    `ExecStartPre=+/usr/sbin/nft -f ${PATHS.etc}/agents.nft`,
  ];
};

export const vmdUnit = (): string =>
  lines([
    "[Unit]",
    "Description=pap-vmd (root helper of the agent VMs)",
    "After=pap-vm-containerd.service pap-vm-buildkit.service",
    "Requires=pap-vm-containerd.service pap-vm-buildkit.service",
    "",
    "[Service]",
    `Environment=PATH=${PATH_ENV}`,
    ...RUNTIME_DIR,
    "StateDirectory=pap-vm",
    ...bridgeSteps(),
    `ExecStart=${PATHS.opt}/node/bin/node ${PATHS.opt}/vmd/dist/main.js`,
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "PrivateTmp=yes",
    "NoNewPrivileges=yes",
    `ReadWritePaths=${PATHS.state} ${PATHS.run} -/run/netns -/run/kata-containers -/var/lib/cni`,
    "Restart=on-failure",
    "",
    ...INSTALL,
  ]);

export const UNIT_FILES: Readonly<Record<(typeof UNIT_NAMES)[number], () => string>> = {
  "pap-vm-containerd.service": containerdUnit,
  "pap-vm-buildkit.service": buildkitUnit,
  "pap-vmd.service": vmdUnit,
};
