import type { VmLayout } from "@pap/contracts";

/** R2, R18: what the agent's shell keeps as guest root. No CAP_SYS_ADMIN, CAP_SYS_CHROOT, CAP_MKNOD, CAP_SYS_PTRACE, CAP_SYS_MODULE, CAP_NET_*. */
export const VM_SHELL_CAPS = [
  "CAP_CHOWN",
  "CAP_DAC_OVERRIDE",
  "CAP_FOWNER",
  "CAP_FSETID",
  "CAP_SETUID",
  "CAP_SETGID",
  "CAP_KILL",
] as const;

export interface VmShellSpec {
  readonly bwrap: string;
  readonly layout: VmLayout;
  /** The worker's slot: its own overlay upper (R27), so two workers' shells never share one. */
  readonly slot: string;
  /** T0a: `overlay` when bwrap can overlay `/` as guest root, else `read-only` (the image root bound read-only in SP1). */
  readonly rootView: "overlay" | "read-only";
  /** Sub-project 2's seam: a per-command proxy socket bound into the shell. Always null in sub-project 1 (no network). */
  readonly egressSocket: string | null;
}
const SLOT = /^[0-9a-f]{32}$/;

/** The shell of an agent in its VM (spec §5, R2). `.pi`, the worker, the guest and `/dev/vsock` are never in its view. */
export function bwrapVmArgv(spec: VmShellSpec, command: string, seccompFd: number): string[] {
  const { layout } = spec;
  if (!SLOT.test(spec.slot) || spec.egressSocket !== null) throw new RangeError("vm shell spec");
  const overlay = `${layout.shellOverlay}/${spec.slot}`;
  const root =
    spec.rootView === "overlay"
      ? ["--overlay-src", "/", "--overlay", `${overlay}/upper`, `${overlay}/work`, "/"]
      : ["--ro-bind", "/", "/"];
  return [
    spec.bwrap,
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    ...VM_SHELL_CAPS.flatMap((cap) => ["--cap-add", cap]),
    ...root,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--tmpfs",
    layout.root,
    ...[layout.home, layout.knowledge, layout.inbox].flatMap((dir) => ["--bind", dir, dir]),
    "--seccomp",
    String(seccompFd),
    "--chdir",
    layout.home,
    "--",
    "/bin/sh",
    "-c",
    command,
  ];
}
