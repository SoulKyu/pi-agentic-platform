import path from "node:path";
import { AGENT_NET, BOX_MOUNT, type BoxRef } from "@pap/contracts";
import { vmName } from "./box-name.ts";
import type { ImageBuildRequest, VmStartRequest } from "./ops.ts";

const BIN = "/opt/pap-vm/bin";
/** R5, RT-34: pap's own containerd, nerdctl state, CNI plugins and network list; never the system ones. */
const NERDCTL = [
  `${BIN}/nerdctl`,
  "--address",
  "/run/pap-vm/containerd.sock",
  "--namespace",
  "pap",
  "--data-root",
  "/var/lib/pap-vm/nerdctl",
  "--cni-path",
  "/opt/pap-vm/libexec/cni",
  "--cni-netconfpath",
  "/etc/pap-vm/cni",
] as const;
/** T0a: `kata-tools-static` installs it here. */
const KATA_CTL = "/opt/kata/bin/kata-ctl";
const MKFS = "/usr/sbin/mkfs.ext4";
const CP = "/usr/bin/cp";

/** Where a box's disk shows up in its VM: the agent's folder, or `/boxes/<project id>` (spec boxes). */
export const mountOf = (box: BoxRef): string => (box.kind === "agent" ? "/agent" : `${BOX_MOUNT}/${box.id}`);
/** The `-v` flags that mount a box's direct volume. */
export const diskFlags = (box: BoxRef, volume: string): readonly string[] => [
  "-v",
  `${volume}:${mountOf(box)}`,
];
/** A local image name that never resolves to a registry (`--pull never` as well). */
export const imageRef = (tag: string): string => `pap.local/${tag}:1`;
/** Where a VM's direct-assigned volume is registered with Kata (AVM-P13). */
export const volumePath = (volumeRoot: string, name: string): string => path.join(volumeRoot, name);

/** T0a: the Kata CLH runtime, and the capabilities bwrap needs as guest root (the VM is the boundary); never `--privileged`. */
export const KATA_RUNTIME: readonly string[] = [
  "--runtime",
  "io.containerd.kata-clh.v2",
  "--cap-add",
  "SYS_ADMIN",
  "--cap-add",
  "NET_ADMIN",
  // T20a: the guest grows its mounted file system with the kernel's online resize (EXT4_IOC_RESIZE_FS needs CAP_SYS_RESOURCE).
  "--cap-add",
  "SYS_RESOURCE",
  "--cap-drop",
  "NET_RAW",
];

/** What pap-vmd chose for this start: the address and MAC it allocated (R22), the disk flags T0a recorded, the env file (R8). */
export interface VmPlacement {
  readonly ip: string;
  readonly mac: string;
  readonly disk: readonly string[];
  readonly envFile: string;
  /** T0a: the runtime name and the guest capabilities bwrap needs as guest root (R2). */
  readonly runtime: readonly string[];
}

export function rmArgv(name: string): string[] {
  return [...NERDCTL, "rm", "--force", name];
}

export function runArgv(request: VmStartRequest, placement: VmPlacement): string[] {
  return [
    ...NERDCTL,
    "run",
    "--detach",
    "--pull",
    "never",
    "--name",
    vmName(request.box, request.taskKey),
    ...placement.runtime,
    "--network",
    AGENT_NET.network,
    "--ip",
    placement.ip,
    "--mac-address",
    placement.mac,
    "--cpus",
    String(request.resources.cpus),
    "--memory",
    `${request.resources.memoryMb}m`,
    "--add-host",
    `llm.internal:${AGENT_NET.host}`,
    "--add-host",
    `claude.internal:${AGENT_NET.host}`,
    "--env-file",
    placement.envFile,
    "--read-only",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/tmp",
    ...placement.disk,
    imageRef(request.image),
  ];
}

export const pauseArgv = (name: string): string[] => [...NERDCTL, "pause", name];
export const unpauseArgv = (name: string): string[] => [...NERDCTL, "unpause", name];
export const inspectArgv = (name: string): string[] => [
  ...NERDCTL,
  "inspect",
  "--format",
  "{{.State.Status}}",
  name,
];
/** One `<name> <status>` line per container of pap's namespace. */
export const psArgv = (): string[] => [...NERDCTL, "ps", "--all", "--format", "{{.Names}} {{.Status}}"];
export const psImagesArgv = (): string[] => [...NERDCTL, "ps", "--all", "--format", "{{.Image}}"];
export const imagesArgv = (): string[] => [...NERDCTL, "images", "--format", "{{.Repository}}:{{.Tag}}"];
/** Kata tests only: one shell command as root in a running box's VM. */
export const guestShellArgv = (name: string, command: string): string[] => [
  ...NERDCTL,
  "exec",
  "--user",
  "0",
  name,
  "sh",
  "-c",
  command,
];
export const rmiArgv = (ref: string): string[] => [...NERDCTL, "rmi", ref];

/** T0a: a regular file as a direct-assigned block volume: no loop device, no host mount. */
export function directVolumeAddArgv(volume: string, device: string): string[] {
  // `discard`: Kata passes the options on to the guest mount, so a deleted file punches a hole in the host file (CLH `sparse=on`, Kata 4.3).
  const info = { "volume-type": "directvol", device, fstype: "ext4", metadata: {}, options: ["discard"] };
  return [KATA_CTL, "direct-volume", "add", volume, JSON.stringify(info)];
}
export const directVolumeRemoveArgv = (volume: string): string[] => [
  KATA_CTL,
  "direct-volume",
  "remove",
  volume,
];

/** R31: only ever on a file pap-vmd just made. */
export const mkfsArgv = (image: string): string[] => [MKFS, "-q", "-F", image];

/** A copy of a stopped box's disk with no zero block allocated (a pre-allocated disk's unwritten extents read as zeros). */
export const sparseCopyArgv = (image: string, copy: string): string[] => [
  CP,
  "--sparse=always",
  "--preserve=mode,ownership,timestamps",
  "--",
  image,
  copy,
];

/** R7, RT-19, RT-33: the Dockerfile lives outside the context; a base build never reuses a cached `apt-get upgrade`. */
export function buildArgv(request: ImageBuildRequest, contextDir: string, dockerfileDir: string): string[] {
  return [
    `${BIN}/buildctl`,
    "--addr",
    "unix:///run/pap-vm/buildkit.sock",
    "build",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${contextDir}`,
    "--local",
    `dockerfile=${dockerfileDir}`,
    "--output",
    `type=image,name=${imageRef(request.tag)},unpack=true`,
    ...(request.layer === "base" ? ["--no-cache"] : []),
  ];
}
