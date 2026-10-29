import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, openSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClock } from "../../testing/guest-harness.ts";
import {
  NETNS_FD,
  nsenterCommand,
  openNetns,
  procNetnsFiles,
  startNsDialer,
  type NetnsFiles,
  type NsDialer,
} from "./ns-dial.ts";

// Mutants, each killed by the case named:
//  - the helper accepts any host                         -> "ignores a request for any other host or port ..."
//  - the helper accepts ports below 1024                 -> "ignores a request for any other host or port ..."
//  - `--target <pid> --all` instead of `--net=<fd>`      -> "nsenter reads the namespace from the inherited descriptor ..."
//  - the start time is not checked                       -> "openNetns keeps the descriptor only when ..."
//  - the namespace is named by a pid path                -> "nsenter reads the namespace from the inherited descriptor ..."
//  - the descriptor is not inherited (no stdio[4])       -> "nsenter reads the namespace from the inherited descriptor ..."
//  - the descriptor is leaked on a refusal               -> "openNetns keeps the descriptor only when ..."
// Not provable here (root only, the Kata journey T11): that `nsenter` really enters the namespace as guest root.

const HELPER = fileURLToPath(new URL("./ns-dialer.ts", import.meta.url));
const stat = (pid: number, start: string): string =>
  `${pid} (comm) S 1 ${Array(17).fill("0").join(" ")} ${start} 12345 678`;

/** A child process that never starts anything: the argv and the stdio the dialer asked for are all a test reads. */
class NeverStarted extends EventEmitter {
  connected = true;
  exitCode = null;
  signalCode = null;
  send = (): boolean => true;
  kill = (): boolean => true;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

/** The helper started as a plain node process (no `nsenter`: that needs root), a descriptor in `stdio[4]`. */
function helper(): { dialer: NsDialer; child: () => ChildProcess; messages: unknown[] } {
  const fd = openSync("/dev/null", "r");
  let started: ChildProcess | undefined;
  const messages: unknown[] = [];
  const dialer = startNsDialer({
    nsFd: fd,
    spawn: ((file: string, args: string[], options: object) => {
      started = spawn(file, args, options as never);
      started.on("message", (raw) => messages.push(raw));
      return started;
    }) as never,
    clock: fakeClock(),
    log: () => undefined,
    command: () => [process.execPath, "--disable-warning=ExperimentalWarning", HELPER],
  });
  closeSync(fd);
  cleanups.push(() => dialer.close());
  return { dialer, child: () => started as ChildProcess, messages };
}

async function listener(): Promise<{ port: number; accepted: net.Socket[] }> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const socket of accepted) socket.destroy();
    server.close();
  });
  return { port: (server.address() as net.AddressInfo).port, accepted };
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("the namespace entry", () => {
  it("nsenter reads the namespace from the inherited descriptor, never from a pid", () => {
    const argv = nsenterCommand();
    expect(argv[0]).toBe("/usr/bin/nsenter");
    expect(argv).toContain(`--net=/proc/self/fd/${NETNS_FD}`);
    const options = argv.filter((arg) => arg.startsWith("--") && arg !== "--");
    expect(options.filter((arg) => !arg.startsWith("--conditions="))).toEqual([
      `--net=/proc/self/fd/${NETNS_FD}`,
    ]);
    expect(argv.join(" ")).not.toMatch(/\/proc\/\d+/);
    expect(argv.join(" ")).not.toContain("--target");
    expect(argv.join(" ")).not.toContain("--all");
    expect(NETNS_FD).toBe(4);

    const calls: Array<{ file: string; args: string[]; stdio: unknown[]; options: object }> = [];
    const fake = new NeverStarted();
    startNsDialer({
      nsFd: 77,
      spawn: ((file: string, args: string[], options: { stdio: unknown[] }) => {
        calls.push({ file, args, stdio: options.stdio, options });
        return fake;
      }) as never,
      clock: fakeClock(),
      log: () => undefined,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.stdio[4]).toBe(77);
    expect(calls[0]?.stdio[3]).toBe("ipc");
    // The helper runs as guest root: nothing of the guest's environment reaches it.
    expect(calls[0]?.options).toMatchObject({ env: { PATH: "/usr/bin:/bin" }, cwd: "/" });
    expect(Object.keys((calls[0]?.options as { env: object }).env)).toEqual(["PATH"]);
    expect(calls[0]?.args).toContain(`--net=/proc/self/fd/${NETNS_FD}`);
  });

  it("openNetns keeps the descriptor only when the pid still has the recorded start time", () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const files = (stats: Record<number, string | null>, failOpen = false): NetnsFiles => ({
      open: (path) => {
        if (failOpen) throw new Error("ENOENT");
        expect(path).toBe("/proc/42/ns/net");
        opened.push(900 + opened.length);
        return opened.at(-1) as number;
      },
      close: (fd) => void closed.push(fd),
      stat: (pid) => stats[pid] ?? null,
    });
    const target = { pid: 42, start: "5000" };

    expect(openNetns(target, files({ 42: stat(42, "5000") }))).toBe(900);
    expect(closed).toEqual([]);

    expect(openNetns(target, files({ 42: stat(42, "5001") }))).toBeNull();
    expect(closed).toEqual([901]);

    expect(openNetns(target, files({ 42: null }))).toBeNull();
    expect(closed).toEqual([901, 902]);

    expect(openNetns(target, files({}, true))).toBeNull();
    expect(closed).toEqual([901, 902]);
  });

  it("on this machine: a live child's namespace opens, and once it is gone the same pid and start open nothing", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    cleanups.push(() => void child.kill("SIGKILL"));
    const pid = child.pid as number;
    await vi.waitFor(() => expect(procNetnsFiles.stat(pid)).not.toBeNull());
    const start = /\) \S+ (?:\S+ ){18}(\d+)/.exec(procNetnsFiles.stat(pid) as string)?.[1] as string;
    const fd = openNetns({ pid, start }, procNetnsFiles);
    expect(fd).not.toBeNull();
    procNetnsFiles.close(fd as number);
    expect(openNetns({ pid, start: `${start}1` }, procNetnsFiles)).toBeNull();

    const gone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await gone;
    expect(openNetns({ pid, start }, procNetnsFiles)).toBeNull();
  });

  it("hands back a socket connected to the port, carrying bytes both ways", async () => {
    const { port, accepted } = await listener();
    const { dialer } = helper();
    const socket = await dialer.dial("127.0.0.1", port);
    cleanups.push(() => socket.destroy());
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    const fromServer: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => fromServer.push(chunk));
    const atServer: Buffer[] = [];
    accepted[0]?.on("data", (chunk: Buffer) => atServer.push(chunk));
    socket.write("GET / HTTP/1.1\r\n\r\n");
    accepted[0]?.write("HTTP/1.1 200 OK\r\n\r\n");
    await vi.waitFor(() => expect(Buffer.concat(atServer).toString()).toBe("GET / HTTP/1.1\r\n\r\n"));
    await vi.waitFor(() => expect(Buffer.concat(fromServer).toString()).toBe("HTTP/1.1 200 OK\r\n\r\n"));
  });

  it("fails a dial to a port nobody listens on", async () => {
    const { dialer } = helper();
    await expect(dialer.dial("127.0.0.1", await freePort())).rejects.toThrow("refused");
  });

  it("fails every pending dial once the helper is gone, and refuses new ones", async () => {
    const { port } = await listener();
    const { dialer, child } = helper();
    // The first dial proves the helper is up; the helper is then stopped before it can answer the next ones.
    (await dialer.dial("127.0.0.1", port)).destroy();
    child().kill("SIGSTOP");
    const first = dialer.dial("127.0.0.1", port);
    const second = dialer.dial("127.0.0.1", port);
    const outcomes = Promise.allSettled([first, second]);
    child().kill("SIGKILL");
    const settled = await outcomes;
    expect(settled.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    await expect(dialer.dial("127.0.0.1", port)).rejects.toThrow("gone");
    expect(dialer.alive()).toBe(false);
  });

  it("refuses the ninth dial in flight", async () => {
    const { dialer, child } = helper();
    const { port } = await listener();
    (await dialer.dial("127.0.0.1", port)).destroy();
    child().kill("SIGSTOP");
    const pending = Array.from({ length: 8 }, () => dialer.dial("127.0.0.1", port));
    const settled = Promise.allSettled(pending);
    await expect(dialer.dial("127.0.0.1", port)).rejects.toThrow("too many");
    child().kill("SIGKILL");
    await settled;
  });

  it("ignores a request for any other host or port, and answers the next good one", async () => {
    const { port, accepted } = await listener();
    const { dialer, child, messages } = helper();
    (await dialer.dial("127.0.0.1", port)).destroy();
    messages.length = 0;
    const bad = [
      { id: 101, host: "127.0.0.2", port },
      { id: 102, host: "localhost", port },
      { id: 103, host: "127.0.0.1", port: 1023 },
      { id: 104, host: "127.0.0.1", port: 0 },
      { id: 105, host: "127.0.0.1", port: 65_536 },
      { id: 106, host: "::2", port },
      { id: 0, host: "127.0.0.1", port },
      { id: "x", host: "127.0.0.1", port },
      { host: "127.0.0.1", port },
      "text",
      null,
    ];
    for (const request of bad) child().send(request as never);
    (await dialer.dial("127.0.0.1", port)).destroy();
    (await dialer.dial("127.0.0.1", port)).destroy();
    expect(messages.map((message) => (message as { id: number }).id).filter((id) => id >= 100)).toEqual([]);
    expect(accepted.length).toBe(3);
  });
});
