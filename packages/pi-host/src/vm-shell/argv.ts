import { posix } from "node:path";
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
  /** The agent's `sandbox.network`: the shell keeps the VM's network namespace (only the egress proxy answers there). */
  readonly network: boolean;
}
const SLOT = /^[0-9a-f]{32}$/;

/** AVM-E19: `/agent/`, `/agent//.pi` and `/agent/a/../.pi` are the paths they land on, compared as such. */
const normal = (dir: string): string => posix.normalize(dir).replace(/(?<=.)\/+$/, "");

/** The shell of an agent in its VM (spec §5, R2). `.pi`, the worker, the guest and `/dev/vsock` are never in its view. */
export function bwrapVmArgv(spec: VmShellSpec, command: string, seccompFd: number): string[] {
  const layout = { ...spec.layout, root: normal(spec.layout.root), pi: normal(spec.layout.pi) };
  if (!SLOT.test(spec.slot)) throw new RangeError("vm shell spec");
  const { project } = spec.layout;
  const binds = (
    project === undefined
      ? [spec.layout.home, spec.layout.knowledge, spec.layout.inbox]
      : [project, spec.layout.home, spec.layout.inbox]
  ).map(normal);
  const [start = ""] = project === undefined ? binds : [normal(project)];
  // `.pi` itself, below it, or an ancestor of it (`/`, the root): none is a bind source.
  const ancestor = (dir: string) => layout.pi.startsWith(dir === "/" ? "/" : `${dir}/`);
  if (
    binds.some(
      (dir) => dir === layout.root || dir === layout.pi || dir.startsWith(`${layout.pi}/`) || ancestor(dir),
    )
  )
    throw new RangeError("vm shell spec");
  const overlay = `${layout.shellOverlay}/${spec.slot}`;
  const root =
    spec.rootView === "overlay"
      ? ["--overlay-src", "/", "--overlay", `${overlay}/upper`, `${overlay}/work`, "/"]
      : ["--ro-bind", "/", "/"];
  return [
    spec.bwrap,
    "--unshare-ipc",
    "--unshare-pid",
    ...(spec.network ? [] : ["--unshare-net"]),
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
    ...binds.flatMap((dir) => ["--bind", dir, dir]),
    "--seccomp",
    String(seccompFd),
    "--chdir",
    start,
    "--",
    "/bin/sh",
    "-c",
    command,
  ];
}
