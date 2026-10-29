import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VmLayout } from "@pap/contracts/pi-host";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bwrapLauncher } from "./launcher.ts";
import { openNetns, procNetnsFiles } from "./ns-dial.ts";
import { checkOwnership, procReader } from "./ownership.ts";

// The real /usr/bin/bwrap with the shell's argv and filter, unprivileged (host user with ambient capabilities in bwrap's own
// user namespace), as launcher.bwrap.int.test.ts. It proves the descriptor half of the namespace entry on a real sandbox:
// `openNetns` holds the sandbox's own network namespace (not the guest's) and keeps it after the sandbox is gone. It does NOT
// prove `nsenter` itself: setns(2) into that namespace needs guest root, which an unprivileged user does not have; the Kata
// journey (T11) proves the entry, the hand-off and that the namespace gains nothing.
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
  throw new Error("ns-dial.bwrap.int.test: CI must provide a working /usr/bin/bwrap");
if (!usable)
  console.warn("ns-dial.bwrap.int.test: skipped: no usable root-owned /usr/bin/bwrap on this machine");

let root: string;
let layout: VmLayout;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-nsdial-bwrap-")));
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

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe.skipIf(!usable)("openNetns on a real no-network sandbox", () => {
  it("holds the sandbox's own namespace by a descriptor that outlives the sandbox", async () => {
    const port = await freePort();
    const child = bwrapLauncher(() => undefined).start({
      layout,
      network: false,
      command: `exec python3 -m http.server ${port} --bind 127.0.0.1`,
      port,
      proxy: {},
    });
    let fd: number | null = null;
    try {
      const pid = child.pid as number;
      const proc = procReader();
      await vi.waitFor(
        () => expect(checkOwnership(pid, port, "child", proc)).toMatchObject({ owned: true }),
        {
          timeout: 20_000,
        },
      );
      const owned = checkOwnership(pid, port, "child", proc);
      if (!owned.owned) throw new Error("not owned");
      const target = { pid: owned.nsPid, start: owned.nsStart };

      // Another start time (a reused pid) opens nothing, and leaves no descriptor behind.
      expect(openNetns({ ...target, start: `${target.start}0` }, procNetnsFiles)).toBeNull();

      fd = openNetns(target, procNetnsFiles);
      expect(fd).not.toBeNull();
      const held = readlinkSync(`/proc/self/fd/${fd}`);
      expect(held).toMatch(/^net:\[\d+\]$/);
      expect(held).toBe(readlinkSync(`/proc/${target.pid}/ns/net`));
      expect(held).not.toBe(readlinkSync("/proc/self/ns/net"));

      child.kill("SIGKILL");
      await vi.waitFor(() => expect(procNetnsFiles.stat(target.pid)).toBeNull(), { timeout: 20_000 });
      expect(readlinkSync(`/proc/self/fd/${fd}`)).toBe(held);
      expect(openNetns(target, procNetnsFiles)).toBeNull();
    } finally {
      if (fd !== null) procNetnsFiles.close(fd);
      child.kill("SIGKILL");
    }
  }, 45_000);
});
