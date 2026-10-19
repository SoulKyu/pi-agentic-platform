import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vmShell } from "./ops.ts";
import type { VmShellSpec } from "./argv.ts";

// The real /usr/bin/bwrap loads the real filter, unprivileged (a user namespace stands in for the guest's root).
// CI must provide a working, root-owned /usr/bin/bwrap; locally the file skips with one line.
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
  throw new Error("ops.bwrap.int.test: CI must provide a working /usr/bin/bwrap");
if (!usable) console.warn("ops.bwrap.int.test: skipped: no usable root-owned /usr/bin/bwrap on this machine");

let root: string;
let spec: VmShellSpec;
const shell = () => {
  const ops = vmShell(spec);
  return async (command: string) => {
    let out = "";
    const { exitCode } = await ops.exec(command, "/", {
      onData: (data) => void (out += data.toString("utf8")),
      timeout: 30,
    });
    return { exitCode, out };
  };
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-vm-shell-int-")));
  const dir = (name: string) => {
    mkdirSync(join(root, "agent", name), { recursive: true });
    return join(root, "agent", name);
  };
  spec = {
    bwrap: BWRAP,
    layout: {
      root: join(root, "agent"),
      home: dir("home"),
      knowledge: dir("knowledge"),
      inbox: dir("inbox"),
      pi: dir(".pi"),
      sessions: dir(".pi/sessions"),
      piAgentDir: join(root, "agent/.pi/agent"),
      imageAgentDir: "/opt/pap/pi-agent",
      shellOverlay: join(root, "overlay"),
    },
    slot: "0123456789abcdef0123456789abcdef",
    rootView: "read-only",
    egressSocket: null,
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!usable)("the VM shell under the real bwrap and the real filter", () => {
  it("keeps exactly the seven capabilities of R2", async () => {
    const { out } = await shell()("grep CapEff /proc/self/status");
    expect(out.trim()).toBe("CapEff:\t00000000000000fb");
  });

  it("refuses socket(AF_VSOCK) and a new user namespace, and has no /dev/vsock", async () => {
    const run = shell();
    const vsock = await run('python3 -c "import socket; socket.socket(40, 1, 0)" 2>&1; echo "rc=$?"');
    expect(vsock.out).toContain("Operation not permitted");
    const user = await run("unshare -U true 2>&1; echo rc=$?");
    expect(user.out).toContain("Operation not permitted");
    const dev = await run("ls /dev");
    expect(dev.out).not.toContain("vsock");
  });

  it("writes only to the home, the knowledge folder and the inbox, and never sees .pi", async () => {
    const run = shell();
    const { layout } = spec;
    const wrote = await run(
      `echo a > ${layout.home}/f; echo b > ${layout.knowledge}/f; echo c > ${layout.inbox}/f; ` +
        `(echo x > ${layout.root}/other) 2>&1; (echo y > /usr/pap-test) 2>&1; ls -A ${layout.root}`,
    );
    expect(readFileSync(join(layout.home, "f"), "utf8")).toBe("a\n");
    expect(readFileSync(join(layout.knowledge, "f"), "utf8")).toBe("b\n");
    expect(readFileSync(join(layout.inbox, "f"), "utf8")).toBe("c\n");
    expect(
      wrote.out.split("\n").filter((line) => !line.includes("denied") && !line.includes("Read-only") && line),
    ).toEqual(["home", "inbox", "knowledge", "other"]);
  });

  it("starts the next command only after the first, and the exit code comes back", async () => {
    const run = shell();
    const [one, two] = await Promise.all([run("exit 3"), run("echo second")]);
    expect(one.exitCode).toBe(3);
    expect(two).toEqual({ exitCode: 0, out: "second\n" });
  });
});
