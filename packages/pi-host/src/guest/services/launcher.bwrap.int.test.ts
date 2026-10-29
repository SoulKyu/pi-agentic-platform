import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VmLayout } from "@pap/contracts/pi-host";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bwrapLauncher } from "./launcher.ts";
import { checkOwnership, procReader, treeOf } from "./ownership.ts";
import { createServiceHost, type ServiceHost } from "./supervisor.ts";

// The real /usr/bin/bwrap with the shell's argv and filter, unprivileged (host user with ambient capabilities in bwrap's own
// user namespace). It is NOT the guest-root path of a Kata VM; the Kata journey proves that. CI must provide a working,
// root-owned /usr/bin/bwrap; locally the file skips with one line.
const BWRAP = "/usr/bin/bwrap";
function bwrapWorks(): boolean {
  try {
    if (statSync(BWRAP).uid !== 0) return false;
    execFileSync(BWRAP, ["--ro-bind", "/", "/", "--unshare-pid", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const usable = bwrapWorks();
if (!usable && process.env.CI)
  throw new Error("launcher.bwrap.int.test: CI must provide a working /usr/bin/bwrap");
if (!usable)
  console.warn("launcher.bwrap.int.test: skipped: no usable root-owned /usr/bin/bwrap on this machine");

let root: string;
let layout: VmLayout;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-service-bwrap-")));
  const dir = (name: string) => {
    mkdirSync(join(root, "agent", name), { recursive: true });
    return join(root, "agent", name);
  };
  layout = {
    root: join(root, "agent"),
    home: dir("home"),
    knowledge: dir("knowledge"),
    inbox: dir("inbox"),
    pi: dir(".pi"),
    sessions: dir(".pi/sessions"),
    piAgentDir: join(root, "agent/.pi/agent"),
    imageAgentDir: "/opt/pap/pi-agent",
    shellOverlay: join(root, "overlay"),
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hosts: ServiceHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.closeAll();
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
const host = (): ServiceHost => {
  const created = createServiceHost({
    layout,
    env: {},
    clock,
    launcher: bwrapLauncher(() => undefined),
    proc: procReader(),
    report: () => undefined,
    log: () => undefined,
  });
  hosts.push(created);
  return created;
};
const server = (port: number) => `exec python3 -m http.server ${port} --bind 127.0.0.1`;

describe.skipIf(!usable)("a service under the real bwrap, the shell's argv and the real filter", () => {
  it("is running once its own process tree listens, with the shell's seccomp filter on fd 3", async () => {
    const port = await freePort();
    const command = `grep '^Seccomp:' /proc/self/status > ${layout.home}/seccomp.txt; ${server(port)}`;
    const answer = await host().op({
      name: "svc.start",
      service: "web",
      command,
      port,
      network: true,
    } as never);
    expect(answer).toMatchObject({ ok: true, value: { name: "web", port, state: "running", reason: null } });
    expect(readFileSync(join(layout.home, "seccomp.txt"), "utf8").trim()).toBe("Seccomp:\t2");
  }, 45_000);

  it("reads the sandbox's own namespace from the outer bwrap's child when the service has no network", async () => {
    const port = await freePort();
    const child = bwrapLauncher(() => undefined).start({
      layout,
      network: false,
      command: server(port),
      port,
      proxy: {},
    });
    try {
      const pid = child.pid as number;
      expect(pid).toBeGreaterThan(1);
      await vi.waitFor(
        () =>
          expect(checkOwnership(pid, port, "child", procReader())).toMatchObject({
            owned: true,
            host: "127.0.0.1",
          }),
        { timeout: 20_000 },
      );
      // The guest's own namespace has no such listener: reading from the outer bwrap itself would have missed it.
      expect(checkOwnership(pid, port, "root", procReader())).toEqual({
        owned: false,
        reason: "not_listening",
      });
    } finally {
      child.kill("SIGKILL");
    }
  }, 45_000);

  it("empties the whole tree when the outer bwrap is stopped", async () => {
    const port = await freePort();
    const service = host();
    await service.op({
      name: "svc.start",
      service: "web",
      command: server(port),
      port,
      network: true,
    } as never);
    const listed = (await service.op({ name: "svc.list" } as never)) as {
      value: { services: Array<{ id: string }> };
    };
    expect(listed.value.services).toHaveLength(1);
    const pids = findTree(port);
    expect(pids.length).toBeGreaterThanOrEqual(3);
    expect(await service.op({ name: "svc.stop", service: "web" } as never)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    await vi.waitFor(() => expect(pids.filter((pid) => procReader().stat(pid) !== null)).toEqual([]), {
      timeout: 10_000,
    });
  }, 45_000);

  it("calls a command that forks away and exits `exited`, and leaves nothing of it running", async () => {
    const answer = await host().op({
      name: "svc.start",
      service: "away",
      command: "sleep 300 & exit 0",
      port: await freePort(),
      network: true,
    } as never);
    expect(answer).toMatchObject({ ok: true, value: { state: "failed", reason: "exited" } });
  }, 45_000);
});

/** The pids of the sandbox tree that listens on `port`: the python server's ancestors up to the outer bwrap. */
function findTree(port: number): number[] {
  const proc = procReader();
  for (const pid of proc.pids()) {
    const line = proc.stat(pid);
    if (line === null || !line.includes("(bwrap)")) continue;
    const tree = treeOf(pid, proc);
    if (checkOwnership(pid, port, "child", proc).owned) return tree;
  }
  return [];
}
