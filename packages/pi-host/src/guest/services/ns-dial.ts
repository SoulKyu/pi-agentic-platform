import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import type { GuestClock } from "../guest.ts";
import { startTimeOf } from "./ownership.ts";

/** util-linux's `nsenter` in the base image: the Kata suite checks it is there (UX2-R kata). */
export const NSENTER = "/usr/bin/nsenter";
/** A dial that has no answer by then fails; a helper never holds more than this many dials. */
export const NS_DIAL_MS = 5_000;
export const NS_DIALS_IN_FLIGHT = 8;

export interface NsDialer {
  /** A socket connected, inside the service's network namespace, to its port on loopback. */
  dial(host: "127.0.0.1" | "::1", port: number): Promise<net.Socket>;
  /** The helper is running and takes dials. */
  alive(): boolean;
  close(): void;
}

/** The descriptor the helper's `nsenter` reads the namespace from: the fifth `stdio` entry, after the IPC channel. */
export const NETNS_FD = 4;

/** What `openNetns` reads; the guest's are the real `/proc` calls, a test gives fakes. */
export interface NetnsFiles {
  open(path: string): number;
  close(fd: number): void;
  stat(pid: number): string | null;
}
export const procNetnsFiles: NetnsFiles = {
  open: (path) => openSync(path, "r"),
  close: (fd) => closeSync(fd),
  stat: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return null;
    }
  },
};

/**
 * Red team M8: the network namespace of a service's sandbox, held by a descriptor before it is used, never by a pid that
 * could be reused meanwhile. The namespace file is opened first, then the pid's start time is read again: equal to what the
 * ownership check recorded (`Ownership.nsStart`), the descriptor names that very process's namespace, which it keeps alive
 * however long the helper runs. Otherwise (the pid is gone or another process holds it) null, and nothing is entered.
 */
export function openNetns(target: { pid: number; start: string }, files: NetnsFiles): number | null {
  let fd: number;
  try {
    fd = files.open(`/proc/${target.pid}/ns/net`);
  } catch {
    return null;
  }
  const stat = files.stat(target.pid);
  if (stat === null || startTimeOf(stat) !== target.start) {
    files.close(fd);
    return null;
  }
  return fd;
}

export interface NsDialerDeps {
  /** The service sandbox's network namespace, from `openNetns`; the helper inherits it, the caller closes its own copy. */
  readonly nsFd: number;
  readonly spawn: typeof nodeSpawn;
  readonly clock: GuestClock;
  readonly log: (line: string) => void;
  /** The command line; tests replace `nsenter` with a plain start of the helper. */
  readonly command?: () => readonly string[];
}

const helperEntry = (): string =>
  fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./ns-dialer.ts" : "./ns-dialer.js", import.meta.url),
  );

/** `nsenter --net=<the inherited namespace descriptor> -- node <helper>`, as guest root: only the network namespace changes. */
export const nsenterCommand = (): readonly string[] => [
  NSENTER,
  `--net=/proc/self/fd/${NETNS_FD}`,
  "--",
  process.execPath,
  ...process.execArgv.filter((arg) => arg.startsWith("--conditions=")),
  helperEntry(),
];

/**
 * A service without network has its own network namespace (bwrap `--unshare-net`): nothing in the VM reaches its loopback.
 * One helper per such service is started inside that namespace only; it opens each connection there and passes the socket
 * back (`process.send` with a handle), so the bytes flow on the guest's own socket and the service's namespace gains no
 * route, no interface and no listener (spec §5: entered, never widened). The helper sits outside bwrap, in the guest's pid
 * namespace: the service can neither see nor signal it.
 */
export function startNsDialer(deps: NsDialerDeps): NsDialer {
  const [file = NSENTER, ...args] = (deps.command ?? nsenterCommand)();
  const child: ChildProcess = deps.spawn(file, args, {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "ignore", "ignore", "ipc", deps.nsFd],
  });
  const pending = new Map<
    number,
    { resolve: (socket: net.Socket) => void; reject: (error: Error) => void; timer: unknown }
  >();
  let next = 0;
  let over = false;
  const settle = (id: number, outcome: net.Socket | Error): void => {
    const waiting = pending.get(id);
    if (waiting === undefined) {
      if (outcome instanceof net.Socket) outcome.destroy();
      return;
    }
    pending.delete(id);
    deps.clock.clearTimeout(waiting.timer);
    if (outcome instanceof net.Socket) waiting.resolve(outcome);
    else waiting.reject(outcome);
  };
  const failAll = (why: string): void => {
    over = true;
    for (const id of [...pending.keys()]) settle(id, new Error(why));
  };
  child.on("message", (raw: unknown, handle: unknown) => {
    const { id, ok } = (typeof raw === "object" && raw !== null ? raw : {}) as { id?: unknown; ok?: unknown };
    if (typeof id !== "number") {
      if (handle instanceof net.Socket) handle.destroy();
      return;
    }
    settle(
      id,
      ok === true && handle instanceof net.Socket ? handle : new Error("the service refused the connection"),
    );
  });
  child.on("error", () => {
    deps.log("the namespace helper could not start");
    failAll("the namespace helper failed");
  });
  child.on("exit", () => failAll("the namespace helper exited"));
  return {
    dial(host, port) {
      if (over || !child.connected) return Promise.reject(new Error("the namespace helper is gone"));
      if (pending.size >= NS_DIALS_IN_FLIGHT) return Promise.reject(new Error("too many dials"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = deps.clock.setTimeout(() => settle(id, new Error("the dial timed out")), NS_DIAL_MS);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, host, port }, (error) => {
          if (error) settle(id, new Error("the namespace helper is gone"));
        });
      });
    },
    alive: () => !over && child.connected,
    close() {
      failAll("closed");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}
