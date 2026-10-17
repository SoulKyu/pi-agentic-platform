import { z } from "zod";

const SandboxPath = z
  .string()
  .min(2)
  .max(4096)
  .refine(
    (path) =>
      /^\/(?:[^\0/]+\/)*[^\0/]+$/.test(path) &&
      !path.split("/").some((part) => part === "." || part === ".."),
    "an absolute path",
  );

/** An interpreter the wrapper runs: plain path characters only, so it can sit unquoted in the fixed `sh` text. */
const ProgramPath = SandboxPath.refine((path) => /^\/[A-Za-z0-9._+/-]+$/.test(path), "a plain program path");

/**
 * What one agent's shell may see and do (ADR 0048). The daemon builds it from the agent profile and its own probe, and
 * sends it in `InitRecord.sandbox`; the worker never widens it (a `policy_update` cannot reach it). Owner m7: no folder
 * of the owner's home is ever bound into it in M11.
 */
export const SandboxSpec = z
  .object({
    /** The probed bwrap (`kernel/sandbox/probe.ts`): absolute, root-owned. The worker never looks one up on PATH. */
    bwrap: SandboxPath,
    /**
     * `host`: the whole system read-only minus `hide` (an agent thread). `system`: only `SYSTEM_FOLDERS`, read-only
     * (an isolated task and an agent trigger's precheck, owner m16).
     */
    view: z.enum(["host", "system"]),
    /** The agent home: bound read-only, or read-write when `writable` is the home. */
    home: SandboxPath,
    /**
     * The one writable folder and the cwd of every command: the home (agent thread), the task's scratch folder outside
     * the home (isolated task, owner m17), or null (a precheck: nothing writable, the cwd is the home).
     */
    writable: SandboxPath.nullable(),
    /** Hidden behind an empty tmpfs, as real folders that exist (a link or a missing one is refused): the owner's home, $PAP_HOME, Pi's agent folder, /var/log, /var/tmp, /var/crash and /var/lib/systemd/coredump. */
    hide: z.array(SandboxPath).min(1).max(12),
    /** True when the shell may reach hosts, only through pap's egress proxy (decision 90); the network namespace is always unshared. */
    network: z.boolean(),
    /** Network only through pap's egress proxy (decision 90): the probed interpreter and the daemon's forwarder file. Present exactly when `network`. */
    egress: z.object({ python: ProgramPath, forwarder: SandboxPath }).strict().nullable(),
  })
  .strict()
  .refine(
    (spec) => spec.network === (spec.egress !== null),
    "a networked sandbox names its egress, and only it",
  );
export type SandboxSpec = z.infer<typeof SandboxSpec>;

/** What an isolated task and a precheck see of the system (owner m16): these folders, read-only, and nothing else. */
export const SYSTEM_FOLDERS = [
  "/usr",
  "/etc",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
] as const;

/** Where the command's proxy socket and the forwarder appear inside a networked sandbox, and the proxy's address there. */
export const EGRESS_SOCKET = "/run/pap-egress.sock";
export const EGRESS_FORWARDER = "/run/pap-fwd.py";
export const EGRESS_PORT = 3128;
const EGRESS_URL = `http://127.0.0.1:${EGRESS_PORT}`;
/** The variables of every command in a networked sandbox (shell and precheck): the forwarder on its loopback is the one way out. */
export const EGRESS_ENV: Readonly<Record<string, string>> = Object.freeze({
  HTTP_PROXY: EGRESS_URL,
  HTTPS_PROXY: EGRESS_URL,
  ALL_PROXY: EGRESS_URL,
  http_proxy: EGRESS_URL,
  https_proxy: EGRESS_URL,
  all_proxy: EGRESS_URL,
  NO_PROXY: "",
  no_proxy: "",
  NODE_USE_ENV_PROXY: "1",
});
/**
 * Starts the forwarder (ready when its parent exits), then replaces itself with `/bin/sh -c "$1"`: the command sees what it sees
 * without network (`$0` is `/bin/sh`, no positional parameters). POSIX sh: /bin/sh may be dash.
 */
export const egressWrapper = (python: string): string =>
  `${python} -I -S ${EGRESS_FORWARDER} ${EGRESS_SOCKET} ${EGRESS_PORT} || { echo "pap: the egress forwarder did not start" >&2; exit 125; }; exec /bin/sh -c "$1"`;
/** What `sun_path` holds: 108 bytes, the last one for the terminator. */
const MAX_SOCKET_BYTES = 107;

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);
const shortestFirst = (paths: readonly string[]): string[] =>
  [...new Set(paths)].sort((a, b) => a.length - b.length);

/**
 * `bwrap <options> -- /bin/sh -c <command>`; with network, `-c <wrapper> pap-sh <command>`: the command is an argument of
 * the fixed wrapper, never part of its text. bwrap applies the options in order: the system read-only (all of it, or
 * the system folders only), fresh /dev, /proc (of the new pid namespace), /run and /tmp, then the hidden folders as
 * empty tmpfs (shortest first), then the home (read-only unless it is the writable folder), then the writable folder,
 * so nothing later hides them. No `--setenv`: values on a command line are readable by every user
 * (`/proc/<pid>/cmdline`); the caller spawns bwrap with the whole environment instead.
 * Always `--unshare-net`: a networked sandbox sees only `lo`, the forwarder on 127.0.0.1:3128 and the command's proxy socket
 * (`socket`, bound at `EGRESS_SOCKET` after the fresh /run). Throws without a socket for a networked spec, or with one over
 * 107 bytes. Throws on a spec that would hide part of the home or of the writable folder, nest the two, or make the home of a
 * `system` view writable (an isolated task never writes its home): a daemon bug, never a fallback. Every hidden folder
 * must exist (bwrap cannot create a mount point on the read-only root and the command then fails, closed).
 */
export function bwrapArgv(spec: SandboxSpec, command: string, socket?: string): string[] {
  const parsed = SandboxSpec.parse(spec);
  if (command.includes("\0")) throw new Error("sandbox: NUL in command");
  const { egress } = parsed;
  let egressMounts: string[] = [];
  if (egress !== null) {
    if (socket === undefined) throw new Error("sandbox: a networked command needs its proxy socket");
    if (new TextEncoder().encode(SandboxPath.parse(socket)).length > MAX_SOCKET_BYTES)
      throw new Error("sandbox: the proxy socket path is too long");
    egressMounts = ["--bind", socket, EGRESS_SOCKET, "--ro-bind", egress.forwarder, EGRESS_FORWARDER];
  }
  const { home, writable } = parsed;
  if (parsed.view === "system" && writable === home)
    throw new Error("sandbox: the home is never writable in the system view");
  const hide = shortestFirst(parsed.hide);
  if (
    hide.some(
      (path) => (path !== home && within(path, home)) || (writable !== null && within(path, writable)),
    )
  )
    throw new Error("sandbox: a hidden folder inside the home or the writable folder");
  if (writable !== null && writable !== home && (within(writable, home) || within(home, writable)))
    throw new Error("sandbox: the writable folder nests with the home");
  const separate = writable !== null && writable !== home;
  return [
    ...(parsed.view === "host"
      ? ["--ro-bind", "/", "/"]
      : SYSTEM_FOLDERS.flatMap((path) => ["--ro-bind-try", path, path])),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/tmp",
    ...egressMounts,
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--unshare-net",
    ...hide.flatMap((path) => ["--tmpfs", path]),
    ...(writable === home ? ["--bind", home, home] : ["--ro-bind", home, home]),
    ...(separate ? ["--bind", writable, writable] : []),
    "--chdir",
    writable ?? home,
    "--die-with-parent",
    "--new-session",
    "--",
    "/bin/sh",
    "-c",
    ...(egress === null ? [command] : [egressWrapper(egress.python), "pap-sh", command]),
  ];
}
