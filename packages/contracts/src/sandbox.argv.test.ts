import { describe, expect, it } from "vitest";
import { bwrapArgv, SandboxSpec, SYSTEM_FOLDERS } from "./sandbox.ts";

const HIDE = ["/home/u/.pap", "/home/u", "/home/u/.pi/agent", "/var/log", "/var/tmp"];
const thread: SandboxSpec = {
  bwrap: "/usr/bin/bwrap",
  view: "host",
  home: "/home/u/.pap/agents/atlas",
  writable: "/home/u/.pap/agents/atlas",
  hide: HIDE,
  network: false,
  egress: null,
};
const task: SandboxSpec = {
  ...thread,
  view: "system",
  writable: "/home/u/.pap/agents/.runs/atlas/t1",
};
const precheck: SandboxSpec = { ...task, writable: null };

const indexOfPair = (argv: string[], flag: string, value: string): number =>
  argv.findIndex((item, i) => item === flag && argv[i + 1] === value);

describe("bwrapArgv, the agent thread (host view)", () => {
  it("pins the whole list and its order", () => {
    expect(bwrapArgv(thread, "echo hi")).toEqual([
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/tmp",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--unshare-net",
      "--tmpfs",
      "/home/u",
      "--tmpfs",
      "/var/log",
      "--tmpfs",
      "/var/tmp",
      "--tmpfs",
      "/home/u/.pap",
      "--tmpfs",
      "/home/u/.pi/agent",
      "--bind",
      "/home/u/.pap/agents/atlas",
      "/home/u/.pap/agents/atlas",
      "--chdir",
      "/home/u/.pap/agents/atlas",
      "--die-with-parent",
      "--new-session",
      "--",
      "/bin/sh",
      "-c",
      "echo hi",
    ]);
  });

  it("hides every parent before anything bound into it, and binds the home after all the hides", () => {
    const argv = bwrapArgv(thread, "true");
    const bind = indexOfPair(argv, "--bind", thread.home);
    for (const path of HIDE) {
      const hide = indexOfPair(argv, "--tmpfs", path);
      expect(hide).toBeGreaterThan(-1);
      expect(hide).toBeLessThan(bind);
    }
    expect(indexOfPair(argv, "--tmpfs", "/home/u")).toBeLessThan(
      indexOfPair(argv, "--tmpfs", "/home/u/.pap"),
    );
    expect(indexOfPair(argv, "--tmpfs", "/home/u/.pap")).toBeLessThan(bind);
  });

  it("never shares the network: --unshare-net and no resolver (a networked spec is in sandbox.egress.test.ts)", () => {
    expect(bwrapArgv(thread, "true")).toContain("--unshare-net");
    expect(bwrapArgv(thread, "true")).not.toContain("/run/systemd/resolve");
  });
});

describe("bwrapArgv, an isolated task (system view)", () => {
  it("binds the system folders only, the home read-only and the scratch folder read-write after it", () => {
    const argv = bwrapArgv(task, "ls");
    expect(argv.slice(0, SYSTEM_FOLDERS.length * 3)).toEqual(
      SYSTEM_FOLDERS.flatMap((path) => ["--ro-bind-try", path, path]),
    );
    expect(indexOfPair(argv, "--ro-bind", "/")).toBe(-1);
    const home = argv.findIndex((item, i) => item === "--ro-bind" && argv[i + 1] === task.home);
    const scratch = indexOfPair(argv, "--bind", task.writable ?? "");
    expect(home).toBeGreaterThan(-1);
    expect(scratch).toBeGreaterThan(home);
    expect(indexOfPair(argv, "--bind", task.home)).toBe(-1);
    expect(indexOfPair(argv, "--chdir", task.writable ?? "")).toBeGreaterThan(scratch);
  });

  it("refuses a writable home in the system view (an isolated task's home is never writable)", () => {
    expect(() => bwrapArgv({ ...task, writable: task.home }, "true")).toThrow(/system view/);
  });
});

describe("bwrapArgv, a precheck (nothing writable)", () => {
  it("binds the home read-only and starts in it", () => {
    const argv = bwrapArgv(precheck, "true");
    expect(indexOfPair(argv, "--ro-bind", precheck.home)).toBeGreaterThan(-1);
    expect(argv.filter((item) => item === "--bind")).toEqual([]);
    expect(indexOfPair(argv, "--chdir", precheck.home)).toBeGreaterThan(-1);
  });
});

describe("bwrapArgv refusals (a daemon bug, never a fallback)", () => {
  const refused = (spec: unknown, command = "true"): void => {
    expect(() => bwrapArgv(spec as SandboxSpec, command)).toThrow();
  };

  it("a hidden folder inside the home or the writable folder", () => {
    refused({ ...thread, hide: [...HIDE, `${thread.home}/memory`] });
    refused({ ...task, hide: [...HIDE, `${task.writable}/x`] });
    refused({ ...task, hide: [...HIDE, `${task.home}/memory`] });
    refused({ ...precheck, hide: [...HIDE, `${precheck.home}/memory`] });
  });

  it("a writable folder inside or above the home", () => {
    refused({ ...task, writable: `${task.home}/scratch` });
    refused({ ...task, home: "/home/u/.pap/agents/atlas", writable: "/home/u/.pap/agents" });
  });

  it("NUL in the command", () => refused(thread, "echo\0hi"));

  it("a relative or dotted path, a readOnly key, an unknown key, too many hides", () => {
    refused({ ...thread, home: "agents/atlas", writable: "agents/atlas" });
    refused({ ...thread, hide: ["home/u"] });
    refused({ ...thread, hide: ["/home/u/../.ssh"] });
    refused({ ...thread, readOnly: ["/home/u/.ssh"] });
    refused({ ...thread, hide: Array.from({ length: 13 }, (_, i) => `/h/${i}`) });
    refused({ ...thread, hide: [] });
  });
});

describe("bwrapArgv carries no environment", () => {
  it("takes (spec, command) only, so no value can reach a command line (/proc/<pid>/cmdline)", () => {
    // (spec, command, socket?): the socket is a path the daemon made, never a value.
    expect(bwrapArgv.length).toBe(3);
    expect(bwrapArgv(thread, "true").some((item) => item === "--setenv" || item === "--unsetenv")).toBe(
      false,
    );
    expect(bwrapArgv(thread, "true")).not.toContain("--clearenv");
  });

  it("holds the command as the last element only", () => {
    const argv = bwrapArgv(thread, "echo $SECRET");
    expect(argv.at(-1)).toBe("echo $SECRET");
    expect(argv.slice(0, -1).some((item) => item.includes("SECRET"))).toBe(false);
  });
});
