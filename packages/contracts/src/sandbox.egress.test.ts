import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  bwrapArgv,
  DaemonToWorker,
  EGRESS_FORWARDER,
  EGRESS_ENV,
  EGRESS_PORT,
  EGRESS_SOCKET,
  egressWrapper,
  parseWorkerRecord,
  SandboxSpec,
} from "./index.ts";

const off: SandboxSpec = {
  bwrap: "/usr/bin/bwrap",
  view: "host",
  home: "/home/u/.pap/agents/atlas",
  writable: "/home/u/.pap/agents/atlas",
  hide: ["/home/u/.pap", "/home/u", "/home/u/.pi/agent", "/var/log", "/var/tmp"],
  network: false,
  egress: null,
};
const on: SandboxSpec = {
  ...off,
  network: true,
  egress: { python: "/usr/bin/python3", forwarder: "/run/user/1000/pap/ab12cd/egress/fwd.py" },
};
const SOCKET = "/run/user/1000/pap/ab12cd/egress/0/1.s";

/** The list a network-off thread got before decision 90, copied from the code as it was (M11R230: byte-identical). */
const NETWORK_OFF_BEFORE = [
  ...["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/run", "--tmpfs", "/tmp"],
  ...["--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--unshare-net"],
  ...["--tmpfs", "/home/u", "--tmpfs", "/var/log", "--tmpfs", "/var/tmp"],
  ...["--tmpfs", "/home/u/.pap", "--tmpfs", "/home/u/.pi/agent"],
  ...["--bind", "/home/u/.pap/agents/atlas", "/home/u/.pap/agents/atlas"],
  ...["--chdir", "/home/u/.pap/agents/atlas", "--die-with-parent", "--new-session"],
  ...["--", "/bin/sh", "-c", "echo hi"],
];

describe("a network-off spec", () => {
  it("gives the argument list it gave before the egress proxy, byte for byte", () => {
    expect(bwrapArgv(off, "echo hi")).toEqual(NETWORK_OFF_BEFORE);
    expect(bwrapArgv(off, "echo hi", SOCKET)).toEqual(NETWORK_OFF_BEFORE);
  });
});

describe("a networked spec (M11R230)", () => {
  const argv = bwrapArgv(on, "curl https://api.example.test", SOCKET);

  it("still unshares the network and no longer binds the resolver", () => {
    expect(argv).toContain("--unshare-net");
    expect(argv.join("\0")).not.toContain("/run/systemd/resolve");
  });

  it("binds the socket and the forwarder right after the fresh /run and /tmp", () => {
    const tmp = argv.findIndex((item, i) => item === "--tmpfs" && argv[i + 1] === "/tmp");
    expect(argv.slice(tmp + 2, tmp + 8)).toEqual([
      ...["--bind", SOCKET, EGRESS_SOCKET],
      ...["--ro-bind", on.egress?.forwarder, EGRESS_FORWARDER],
    ]);
    expect(argv.findIndex((item, i) => item === "--tmpfs" && argv[i + 1] === "/run")).toBeLessThan(tmp);
    expect(argv.indexOf("--unshare-pid")).toBe(tmp + 8);
  });

  it("runs the fixed wrapper with the command as its first argument", () => {
    expect(argv.slice(-5)).toEqual([
      "/bin/sh",
      "-c",
      egressWrapper("/usr/bin/python3"),
      "pap-sh",
      "curl https://api.example.test",
    ]);
    expect(egressWrapper("/usr/bin/python3")).toBe(
      `/usr/bin/python3 -I -S ${EGRESS_FORWARDER} ${EGRESS_SOCKET} ${EGRESS_PORT} || { echo "pap: the egress forwarder did not start" >&2; exit 125; }; exec /bin/sh -c "$1"`,
    );
    expect([EGRESS_SOCKET, EGRESS_FORWARDER, EGRESS_PORT]).toEqual([
      "/run/pap-egress.sock",
      "/run/pap-fwd.py",
      3128,
    ]);
  });

  it("keeps a hostile command one argument, never part of the wrapper's text", () => {
    const hostile = `"; rm -rf ~ #`;
    const list = bwrapArgv(on, hostile, SOCKET);
    expect(list.at(-1)).toBe(hostile);
    expect(list.at(-3)).toBe(egressWrapper("/usr/bin/python3"));
    expect(list.filter((item) => item.includes("rm -rf"))).toEqual([hostile]);
  });

  it("throws without a socket, with a path over 107 bytes, and with a multi-byte one over 107 bytes but under 107 characters", () => {
    expect(() => bwrapArgv(on, "true")).toThrow(/socket/);
    expect(bwrapArgv(on, "true", `/${"a".repeat(106)}`)).toContain("--bind");
    expect(() => bwrapArgv(on, "true", `/${"a".repeat(107)}`)).toThrow(/too long/);
    const wide = `/${"é".repeat(54)}`;
    expect(wide.length).toBeLessThan(107);
    expect(new TextEncoder().encode(wide).length).toBeGreaterThan(107);
    expect(() => bwrapArgv(on, "true", wide)).toThrow(/too long/);
  });

  it("throws on a socket that is not an absolute plain path", () => {
    for (const bad of ["relative.s", "/a/../b.s", "/a\0b.s"])
      expect(() => bwrapArgv(on, "true", bad)).toThrow();
  });
});

describe("the wrapper's command sees what it sees without network", () => {
  it("has $0 = /bin/sh and no positional parameters, whatever the wrapper was given", () => {
    // /bin/true stands in for the interpreter: it starts and returns, like a forwarder that is ready.
    const out = execFileSync(
      "/bin/sh",
      ["-c", egressWrapper("/bin/true"), "pap-sh", 'echo "[$0] [$1] [$#]"'],
      {
        encoding: "utf8",
      },
    );
    const plain = execFileSync("/bin/sh", ["-c", 'echo "[$0] [$1] [$#]"'], { encoding: "utf8" });
    expect(out).toBe(plain);
    expect(out).toBe("[/bin/sh] [] [0]\n");
  });
});

describe("SandboxSpec.egress (M11R230)", () => {
  it("is present exactly when the spec has network", () => {
    expect(SandboxSpec.safeParse(on).success).toBe(true);
    expect(SandboxSpec.safeParse(off).success).toBe(true);
    expect(SandboxSpec.safeParse({ ...off, network: true }).success).toBe(false);
    expect(SandboxSpec.safeParse({ ...on, egress: null }).success).toBe(false);
    expect(SandboxSpec.safeParse({ ...off, egress: on.egress }).success).toBe(false);
    const without = Object.fromEntries(Object.entries(off).filter(([key]) => key !== "egress"));
    expect(SandboxSpec.safeParse(without).success).toBe(false);
  });

  it("refuses an interpreter path with a quote, a space or another shell character", () => {
    for (const python of [
      "/usr/bin/py thon",
      '/usr/bin/py"thon',
      "/usr/bin/py'thon",
      "/usr/bin/p;ython",
      "/usr/bin/$X",
      "/usr/bin/p`x`",
      "python3",
    ]) {
      const spec = { ...on, egress: { python, forwarder: "/run/fwd.py" } };
      expect(SandboxSpec.safeParse(spec).success, python).toBe(false);
    }
    expect(
      SandboxSpec.safeParse({ ...on, egress: { python: "/usr/bin/python3.12", forwarder: "/run/f.py" } })
        .success,
    ).toBe(true);
  });

  it("refuses an extra key in egress and a forwarder that is not an absolute path", () => {
    expect(SandboxSpec.safeParse({ ...on, egress: { ...on.egress, extra: 1 } }).success).toBe(false);
    expect(
      SandboxSpec.safeParse({ ...on, egress: { python: "/usr/bin/python3", forwarder: "fwd.py" } }).success,
    ).toBe(false);
  });
});

describe("the egress records of the worker channel", () => {
  it("lets the daemon send egress_opened and egress_report to a worker", () => {
    const socket = "/run/user/1000/pap/ab12cd/egress/0/1.s";
    expect(DaemonToWorker.safeParse({ type: "egress_opened", id: "c1", socket, reason: null }).success).toBe(
      true,
    );
    expect(
      DaemonToWorker.safeParse({ type: "egress_opened", id: "c1", socket: null, reason: "limit" }).success,
    ).toBe(true);
    expect(
      DaemonToWorker.safeParse({
        type: "egress_report",
        id: "c1",
        hosts: [],
        truncated: false,
        up: 0,
        down: 0,
      }).success,
    ).toBe(true);
    expect(DaemonToWorker.safeParse({ type: "egress_opened", id: "c 1", socket, reason: null }).success).toBe(
      false,
    );
  });

  it("lets a worker send egress_open and egress_close, and forwards nothing else as a pap record", () => {
    expect(parseWorkerRecord({ type: "egress_open", id: "c1" })).toEqual({ type: "egress_open", id: "c1" });
    expect(parseWorkerRecord({ type: "egress_close", id: "c1" })).toEqual({ type: "egress_close", id: "c1" });
    expect(parseWorkerRecord({ type: "egress_open", id: "c 1" })).toBeNull();
    expect(parseWorkerRecord({ type: "egress_open", id: "c1", extra: 1 })).toBeNull();
  });
});

describe("EGRESS_ENV", () => {
  it("points every proxy variable at the forwarder and keeps nothing else out of NO_PROXY", () => {
    const url = `http://127.0.0.1:${EGRESS_PORT}`;
    expect(EGRESS_ENV).toMatchObject({
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      ALL_PROXY: url,
      NO_PROXY: "",
      no_proxy: "",
    });
    expect(Object.isFrozen(EGRESS_ENV)).toBe(true);
  });
});
