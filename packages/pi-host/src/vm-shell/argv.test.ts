import { describe, expect, it } from "vitest";
import { bwrapVmArgv, VM_SHELL_CAPS, type VmShellSpec } from "./argv.ts";

const SLOT = "0123456789abcdef0123456789abcdef";
const layout = {
  root: "/agent",
  home: "/agent/home",
  knowledge: "/agent/knowledge",
  inbox: "/agent/inbox",
  pi: "/agent/.pi",
  sessions: "/agent/.pi/sessions",
  piAgentDir: "/agent/.pi/agent",
  imageAgentDir: "/opt/pap/pi-agent",
  shellOverlay: "/run/pap-shell",
};
const spec = (over: Partial<VmShellSpec> = {}): VmShellSpec => ({
  bwrap: "/usr/bin/bwrap",
  layout,
  slot: SLOT,
  rootView: "read-only",
  egressSocket: null,
  ...over,
});
const argv = (over: Partial<VmShellSpec> = {}, command = "echo hi", fd = 3) =>
  bwrapVmArgv(spec(over), command, fd);
const after = (list: string[], flag: string): string[] => {
  const at = list.indexOf(flag);
  return at < 0 ? [] : list.slice(at + 1);
};

describe("bwrapVmArgv", () => {
  it("starts with bwrap and unshares ipc, pid, net, uts and cgroup, never the user namespace", () => {
    const list = argv();
    expect(list[0]).toBe("/usr/bin/bwrap");
    for (const flag of [
      "--unshare-net",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup",
    ])
      expect(list).toContain(flag);
    expect(list).not.toContain("--unshare-user");
    expect(list).not.toContain("--unshare-user-try");
    expect(list).not.toContain("--unshare-all");
  });

  it("drops every capability and adds back exactly the seven of R2", () => {
    const list = argv();
    expect(list.slice(list.indexOf("--cap-drop"), list.indexOf("--cap-drop") + 2)).toEqual([
      "--cap-drop",
      "ALL",
    ]);
    const added = list.flatMap((arg, i) => (arg === "--cap-add" ? [list[i + 1]] : []));
    expect(added).toEqual([
      "CAP_CHOWN",
      "CAP_DAC_OVERRIDE",
      "CAP_FOWNER",
      "CAP_FSETID",
      "CAP_SETUID",
      "CAP_SETGID",
      "CAP_KILL",
    ]);
    expect(VM_SHELL_CAPS).toHaveLength(7);
    for (const never of ["CAP_SYS_ADMIN", "CAP_SYS_CHROOT", "CAP_MKNOD", "CAP_SYS_PTRACE", "CAP_SYS_MODULE"])
      expect(list).not.toContain(never);
    expect(list.some((arg) => arg.startsWith("CAP_NET_"))).toBe(false);
  });

  it("binds exactly the home, the knowledge folder and the inbox, and hides the rest of the agent folder", () => {
    const list = argv();
    const binds = list.flatMap((arg, i) => (arg === "--bind" ? [[list[i + 1], list[i + 2]]] : []));
    expect(binds).toEqual([
      ["/agent/home", "/agent/home"],
      ["/agent/knowledge", "/agent/knowledge"],
      ["/agent/inbox", "/agent/inbox"],
    ]);
    expect(after(list, "--tmpfs")).toContain("/tmp");
    const tmpfs = list.flatMap((arg, i) => (arg === "--tmpfs" ? [list[i + 1]] : []));
    expect(tmpfs).toEqual(["/tmp", "/run", "/agent"]);
    // The tmpfs on the agent folder comes before the three binds: `.pi` is under it and is never bound.
    expect(list.indexOf("/agent")).toBeLessThan(list.indexOf("--bind"));
  });

  it("never names a device bind, /dev/vsock, .pi or the layout root as a bind source", () => {
    for (const rootView of ["read-only", "overlay"] as const) {
      const list = argv({ rootView });
      expect(list).not.toContain("--dev-bind");
      expect(list).not.toContain("--dev-bind-try");
      expect(list).not.toContain("--bind-try");
      expect(list.join("\0")).not.toContain("vsock");
      expect(list.join("\0")).not.toContain(".pi");
      const sources = list.flatMap((arg, i) =>
        arg === "--bind" || arg === "--ro-bind" ? [list[i + 1]] : [],
      );
      expect(sources).not.toContain("/agent");
      expect(sources).not.toContain(layout.root);
    }
    expect(argv()).toContain("--dev");
  });

  it("read-only: the image root is bound read-only and no overlay is named", () => {
    const list = argv({ rootView: "read-only" });
    const at = list.indexOf("--ro-bind");
    expect(list.slice(at, at + 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(list).not.toContain("--overlay");
    expect(list).not.toContain("--overlay-src");
  });

  it("overlay: the upper and the work folders are the slot's own under the shell overlay", () => {
    const list = argv({ rootView: "overlay" });
    const at = list.indexOf("--overlay");
    expect(list.slice(at - 2, at + 4)).toEqual([
      "--overlay-src",
      "/",
      "--overlay",
      `/run/pap-shell/${SLOT}/upper`,
      `/run/pap-shell/${SLOT}/work`,
      "/",
    ]);
    expect(list).not.toContain("--ro-bind");
  });

  it("two slots never share an overlay upper", () => {
    const other = "fedcba9876543210fedcba9876543210";
    const a = argv({ rootView: "overlay" }).join("\0");
    const b = argv({ rootView: "overlay", slot: other }).join("\0");
    expect(a).not.toContain(other);
    expect(b).not.toContain(SLOT);
  });

  it("names the seccomp descriptor it is given", () => {
    expect(after(argv({}, "x", 3), "--seccomp")[0]).toBe("3");
    expect(after(argv({}, "x", 9), "--seccomp")[0]).toBe("9");
  });

  it("runs the command last, after `--`, through sh -c, in the home", () => {
    const command = "echo '--cap-add CAP_SYS_ADMIN' ; ls";
    const list = argv({}, command);
    expect(list.slice(-4)).toEqual(["--", "/bin/sh", "-c", command]);
    expect(list.indexOf("--")).toBe(list.length - 4);
    expect(after(list, "--chdir")[0]).toBe("/agent/home");
    expect(list.filter((arg) => arg === "--")).toHaveLength(1);
  });

  it("refuses a slot that is not 32 lower-case hex characters", () => {
    for (const slot of [
      "",
      "abc",
      `${SLOT}0`,
      SLOT.toUpperCase(),
      `../${SLOT.slice(3)}`,
      `${SLOT.slice(1)}/`,
    ])
      expect(() => argv({ slot, rootView: "overlay" })).toThrow(RangeError);
    // A trailing newline must not slip past the pattern.
    expect(() => argv({ slot: `${SLOT}\n` })).toThrow(RangeError);
  });

  it("refuses an egress socket: sub-project 1 has no network", () => {
    expect(() => argv({ egressSocket: "/run/egress.sock" })).toThrow(RangeError);
  });

  it("refuses a bind source that is the layout root or is, or lies under, .pi", () => {
    for (const home of ["/agent", "/agent/.pi", "/agent/.pi/sessions"])
      expect(() => argv({ layout: { ...layout, home } })).toThrow(RangeError);
    expect(() => argv({ layout: { ...layout, inbox: "/agent/.pi" } })).toThrow(RangeError);
    expect(() => argv({ layout: { ...layout, knowledge: "/agent" } })).toThrow(RangeError);
    // A sibling whose name only starts like .pi is fine.
    expect(() => argv({ layout: { ...layout, home: "/agent/.pi-notes" } })).not.toThrow();
  });
});
