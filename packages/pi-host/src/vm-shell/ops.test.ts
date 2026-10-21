import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellTimers } from "../shell-process.ts";
import { bwrapVmArgv, type VmShellSpec } from "./argv.ts";
import { vmShell } from "./ops.ts";
import { encodeSeccomp, shellSeccompProgram } from "./seccomp.ts";

const SLOT = "0123456789abcdef0123456789abcdef";

interface Spawned {
  readonly file: string;
  readonly argv: readonly string[];
  readonly options: { cwd?: string; env?: Record<string, string>; detached?: boolean; stdio?: unknown };
  readonly child: EventEmitter & {
    pid: number | undefined;
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: unknown[];
  };
  readonly filter: Buffer[];
  readonly filterEnded: { value: boolean };
}

let root: string;
let spec: VmShellSpec;
let spawned: Spawned[];
let kill: ReturnType<typeof vi.spyOn>;
let fired: Array<{ fn: () => void; ms: number; cleared: boolean }>;

const timers: ShellTimers = {
  setTimeout: (fn, ms) => {
    const entry = { fn, ms, cleared: false };
    fired.push(entry);
    return entry;
  },
  clearTimeout: (handle) => void ((handle as { cleared: boolean }).cleared = true),
};
const fakeSpawn = ((file: string, argv: readonly string[], options: Spawned["options"]) => {
  const fd3 = new PassThrough();
  const filter: Buffer[] = [];
  const filterEnded = { value: false };
  fd3.on("data", (chunk: Buffer) => filter.push(chunk));
  fd3.on("end", () => (filterEnded.value = true));
  const child = Object.assign(new EventEmitter(), {
    pid: (424_242 + spawned.length) as number | undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [null, null, null, fd3] as unknown[],
  });
  spawned.push({ file, argv, options, child, filter, filterEnded });
  return child;
}) as unknown as typeof nodeSpawn;

const shell = () => vmShell(spec, { timers, spawn: fakeSpawn });
const run = (ops = shell(), command = "echo hi", options: { signal?: AbortSignal; timeout?: number } = {}) =>
  ops.exec(command, "/", { onData: () => {}, ...options });
const settled = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-vm-shell-ops-"));
  spec = {
    bwrap: "/usr/bin/bwrap",
    layout: {
      root: "/agent",
      home: "/agent/home",
      knowledge: "/agent/knowledge",
      inbox: "/agent/inbox",
      pi: "/agent/.pi",
      sessions: "/agent/.pi/sessions",
      piAgentDir: "/agent/.pi/agent",
      imageAgentDir: "/opt/pap/pi-agent",
      shellOverlay: join(root, "overlay"),
    },
    slot: SLOT,
    rootView: "read-only",
    network: false,
  };
  spawned = [];
  fired = [];
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => {
  kill.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("vmShell", () => {
  it("spawns bwrapVmArgv with the seccomp descriptor 3 and a fourth pipe", async () => {
    const pending = run();
    await settled();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      file: "/usr/bin/bwrap",
      argv: bwrapVmArgv(spec, "echo hi", 3).slice(1),
    });
    expect(spawned[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe", "pipe"]);
    expect(spawned[0]?.options.detached).toBe(true);
    spawned[0]?.child.emit("close", 0, null);
    await expect(pending).resolves.toEqual({ exitCode: 0 });
  });

  it("writes the encoded filter to fd 3 and ends it", async () => {
    const pending = run();
    await settled();
    const sent = spawned[0];
    expect(Buffer.concat(sent?.filter ?? [])).toEqual(encodeSeccomp(shellSeccompProgram()));
    expect(sent?.filterEnded.value).toBe(true);
    sent?.child.emit("close", 0, null);
    await pending;
  });

  it("gives the shell a fixed environment, never the worker's or the one Pi passes", async () => {
    vi.stubEnv("PAP_RELAY_KEY", "k".repeat(64));
    try {
      const pending = shell().exec("env", "/", {
        onData: () => {},
        env: { SECRET: "s", PATH: "/evil" },
      });
      await settled();
      const env = spawned[0]?.options.env ?? {};
      expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TERM"]);
      expect(env.HOME).toBe("/agent/home");
      expect(env.PATH).not.toContain("/evil");
      expect(JSON.stringify(env)).not.toContain("k".repeat(64));
      spawned[0]?.child.emit("close", 0, null);
      await pending;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("queues a second command until the first has exited (R27)", async () => {
    const ops = shell();
    const first = run(ops, "one");
    const second = run(ops, "two");
    await settled();
    expect(spawned).toHaveLength(1);
    spawned[0]?.child.emit("close", 0, null);
    await expect(first).resolves.toEqual({ exitCode: 0 });
    await settled();
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.argv.at(-1)).toBe("two");
    spawned[1]?.child.emit("close", 3, null);
    await expect(second).resolves.toEqual({ exitCode: 3 });
  });

  it("a failing first command does not block the queue", async () => {
    const ops = shell();
    const first = run(ops, "one", { timeout: 5 });
    const second = run(ops, "two");
    await settled();
    fired[0]?.fn();
    spawned[0]?.child.emit("close", null, "SIGKILL");
    await expect(first).rejects.toThrow("timeout:5");
    await settled();
    expect(spawned).toHaveLength(2);
    spawned[1]?.child.emit("close", 0, null);
    await expect(second).resolves.toEqual({ exitCode: 0 });
  });

  it("a command aborted while it waits never starts", async () => {
    const ops = shell();
    const first = run(ops, "one");
    const controller = new AbortController();
    const second = run(ops, "two", { signal: controller.signal });
    await settled();
    controller.abort();
    spawned[0]?.child.emit("close", 0, null);
    await first;
    await expect(second).rejects.toThrow("aborted");
    await settled();
    expect(spawned).toHaveLength(1);
  });

  it("refuses commands beyond the queue bound", async () => {
    const ops = shell();
    const calls = Array.from({ length: 33 }, (_, i) => run(ops, `c${i}`));
    const last = calls[32];
    await expect(last).rejects.toThrow("too many queued commands");
    for (const [i, call] of calls.slice(0, 32).entries()) {
      await settled();
      spawned[i]?.child.emit("close", 0, null);
      await call;
    }
  });

  it("the timeout kills the process group, never pid 0 or 1", async () => {
    const pending = run(shell(), "sleep 9", { timeout: 2 });
    await settled();
    expect(fired.map((f) => f.ms)).toEqual([2000]);
    fired[0]?.fn();
    expect(kill).toHaveBeenCalledWith(-(spawned[0]?.child.pid ?? 0), "SIGKILL");
    expect(spawned[0]?.child.pid).toBeGreaterThan(1);
    spawned[0]?.child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toThrow("timeout:2");
    expect(fired[0]?.cleared).toBe(true);
  });

  it("Stop kills the process group and the call rejects as aborted", async () => {
    const controller = new AbortController();
    const pending = run(shell(), "sleep 9", { signal: controller.signal });
    await settled();
    controller.abort();
    expect(kill).toHaveBeenCalledWith(-(spawned[0]?.child.pid ?? 0), "SIGKILL");
    spawned[0]?.child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toThrow("aborted");
  });

  it("refuses an invalid timeout without starting anything", async () => {
    await expect(run(shell(), "x", { timeout: Number.NaN })).rejects.toThrow("Invalid timeout");
    await settled();
    expect(spawned).toHaveLength(0);
  });

  it("overlay: creates the slot's upper and work folders 0700, once", async () => {
    spec = { ...spec, rootView: "overlay" };
    const ops = shell();
    const pending = run(ops);
    await settled();
    for (const name of ["upper", "work"]) {
      const stat = statSync(join(root, "overlay", SLOT, name));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
    }
    spawned[0]?.child.emit("close", 0, null);
    await pending;
  });

  it("read-only: creates no overlay folder", async () => {
    const pending = run();
    await settled();
    expect(() => statSync(join(root, "overlay"))).toThrow();
    spawned[0]?.child.emit("close", 0, null);
    await pending;
  });

  it("adds the proxy keys only when network is on, and still no PAP_ key", async () => {
    const proxyEnv = {
      HTTP_PROXY: "http://10.213.0.1:7843",
      NO_PROXY: "llm.internal",
      NODE_USE_ENV_PROXY: "1",
    };
    const off = vmShell({ ...spec, network: false }, { timers, spawn: fakeSpawn, proxyEnv });
    const first = run(off);
    await settled();
    expect(Object.keys(spawned[0]?.options.env ?? {}).sort()).toEqual(["HOME", "LANG", "PATH", "TERM"]);
    spawned[0]?.child.emit("close", 0, null);
    await first;
    const on = vmShell({ ...spec, network: true }, { timers, spawn: fakeSpawn, proxyEnv });
    const second = run(on);
    await settled();
    const env = spawned[1]?.options.env ?? {};
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "HTTP_PROXY",
      "LANG",
      "NODE_USE_ENV_PROXY",
      "NO_PROXY",
      "PATH",
      "TERM",
    ]);
    expect(Object.keys(env).some((key) => key.startsWith("PAP_"))).toBe(false);
    expect(spawned[1]?.argv).not.toContain("--unshare-net");
    spawned[1]?.child.emit("close", 0, null);
    await second;
  });

  it("a bad spec fails the command and starts nothing", async () => {
    const bad = vmShell({ ...spec, slot: "bad" }, { timers, spawn: fakeSpawn });
    await expect(run(bad)).rejects.toThrow(RangeError);
    expect(spawned).toHaveLength(0);
  });
});
