import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { bwrapArgv, type SandboxSpec } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxedShell, type ShellTimers } from "./sandbox-ops.ts";

interface Spawned {
  readonly file: string;
  readonly argv: readonly string[];
  readonly options: { cwd?: string; env?: Record<string, string>; detached?: boolean; stdio?: unknown };
  readonly child: EventEmitter & { pid: number | undefined; stdout: PassThrough; stderr: PassThrough };
}

let root: string;
let spec: SandboxSpec;
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
  const child = Object.assign(new EventEmitter(), {
    pid: 424_242 as number | undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  spawned.push({ file, argv, options, child });
  return child;
}) as unknown as typeof nodeSpawn;

const shell = (
  envFor: (command: string) => Record<string, string> = () => ({ HOME: spec.home, PATH: "/usr/bin" }),
) => sandboxedShell(spec, envFor, { timers, spawn: fakeSpawn });
const run = (ops = shell(), command = "echo hi", options: { signal?: AbortSignal; timeout?: number } = {}) =>
  ops.exec(command, "/", { onData: () => {}, ...options });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-sandbox-ops-")));
  const dirs = ["home/.pap/agents/atlas", "home/.pap/agents/.runs/atlas/t1", "var-log", "var-tmp"];
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  const home = join(root, "home/.pap/agents/atlas");
  spec = {
    bwrap: "/usr/bin/bwrap",
    view: "host",
    home,
    writable: home,
    hide: [join(root, "home"), join(root, "var-log"), join(root, "var-tmp")],
    network: false,
    egress: null,
  };
  spawned = [];
  fired = [];
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => {
  kill.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("sandboxedShell (M11R23)", () => {
  it("runs bwrap with bwrapArgv, detached, in the writable folder whatever cwd the call names", async () => {
    const done = run();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ file: "/usr/bin/bwrap", argv: bwrapArgv(spec, "echo hi") });
    expect(spawned[0]?.options).toMatchObject({
      cwd: spec.home,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned[0]?.child.emit("close", 0, null);
    await expect(done).resolves.toEqual({ exitCode: 0 });
  });

  it("uses the scratch folder of a task as cwd", async () => {
    const scratch = join(root, "home/.pap/agents/.runs/atlas/t1");
    spec = { ...spec, view: "system", writable: scratch };
    const done = run();
    expect(spawned[0]?.options.cwd).toBe(scratch);
    spawned[0]?.child.emit("close", 0, null);
    await done;
  });

  it("gives the child exactly the environment envFor returns, never Pi's env argument", async () => {
    const given = { HOME: spec.home, PATH: "/usr/bin", VAULT_TOKEN: "v-0123456789" };
    const ops = shell(() => given);
    const done = ops.exec("env", "/", {
      onData: () => {},
      env: { ANTHROPIC_API_KEY: "sk-test-0123456789" },
    });
    expect(spawned[0]?.options.env).toEqual(given);
    expect(spawned[0]?.options.env).not.toBe(given);
    expect(spawned[0]?.argv.join("\0")).not.toContain("v-0123456789");
    spawned[0]?.child.emit("close", 0, null);
    await done;
  });

  it("asks envFor for the command it runs", async () => {
    const seen: string[] = [];
    const done = run(
      shell((command) => (seen.push(command), { PATH: "/usr/bin" })),
      "echo $NAME",
    );
    spawned[0]?.child.emit("close", 0, null);
    await done;
    expect(seen).toEqual(["echo $NAME"]);
  });

  it("streams stdout and stderr to onData", async () => {
    const chunks: string[] = [];
    const done = shell().exec("x", "/", { onData: (data) => chunks.push(data.toString()) });
    spawned[0]?.child.stdout.emit("data", Buffer.from("out"));
    spawned[0]?.child.stderr.emit("data", Buffer.from("err"));
    spawned[0]?.child.emit("close", 0, null);
    await done;
    expect(chunks).toEqual(["out", "err"]);
  });

  it("reports a signal death as 128 + the signal, and a null code without a signal as 1", async () => {
    const killed = run();
    spawned[0]?.child.emit("close", null, "SIGKILL");
    await expect(killed).resolves.toEqual({ exitCode: 137 });
    const odd = run();
    spawned[1]?.child.emit("close", null, null);
    await expect(odd).resolves.toEqual({ exitCode: 1 });
  });

  it("kills the whole group (-pid) on abort, and rejects 'aborted'", async () => {
    const controller = new AbortController();
    const done = run(shell(), "sleep 300", { signal: controller.signal });
    controller.abort();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-424_242, "SIGKILL");
    spawned[0]?.child.emit("close", null, "SIGKILL");
    await expect(done).rejects.toThrow("aborted");
  });

  it("rejects without spawning when the signal is already aborted", async () => {
    await expect(run(shell(), "ls", { signal: AbortSignal.abort() })).rejects.toThrow("aborted");
    expect(spawned).toEqual([]);
  });

  it("kills the group when the timeout fires through the seam, and rejects 'timeout:N'", async () => {
    const done = run(shell(), "sleep 300", { timeout: 5 });
    expect(fired).toMatchObject([{ ms: 5000, cleared: false }]);
    expect(kill).not.toHaveBeenCalled();
    fired[0]?.fn();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-424_242, "SIGKILL");
    spawned[0]?.child.emit("close", null, "SIGKILL");
    await expect(done).rejects.toThrow("timeout:5");
    expect(fired[0]?.cleared).toBe(true);
  });

  it("clears the timer when the command ends first", async () => {
    const done = run(shell(), "true", { timeout: 5 });
    spawned[0]?.child.emit("close", 0, null);
    await done;
    expect(fired[0]?.cleared).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 3_000_000])(
    "refuses the timeout %s without spawning",
    async (timeout) => {
      await expect(run(shell(), "ls", { timeout })).rejects.toThrow(/timeout/i);
      expect(spawned).toEqual([]);
    },
  );

  it.each([undefined, 0, 1, -1])(
    "never signals pid %s, 0 or 1 (that would be the user's processes)",
    async (pid) => {
      const controller = new AbortController();
      const done = run(shell(), "ls", { signal: controller.signal });
      if (spawned[0]) spawned[0].child.pid = pid;
      controller.abort();
      expect(kill).not.toHaveBeenCalled();
      spawned[0]?.child.emit("close", null, "SIGKILL");
      await expect(done).rejects.toThrow("aborted");
    },
  );

  it("rejects on a spawn error and never falls back to an unsandboxed sh", async () => {
    const done = run();
    spawned[0]?.child.emit("error", new Error("ENOENT bwrap"));
    await expect(done).rejects.toThrow("ENOENT bwrap");
    expect(spawned).toHaveLength(1);
    expect(spawned.every((entry) => entry.file === "/usr/bin/bwrap")).toBe(true);
  });

  it("rejects a spawn that throws synchronously", async () => {
    const throwing = sandboxedShell(spec, () => ({}), {
      timers,
      spawn: (() => {
        throw new Error("EACCES");
      }) as unknown as typeof nodeSpawn,
    });
    await expect(run(throwing)).rejects.toThrow("EACCES");
  });
});

describe("sandboxedShell refuses a spec the host's folders contradict", () => {
  const plantLink = (): string => {
    const real = join(root, "real");
    mkdirSync(join(real, "sub"), { recursive: true });
    symlinkSync(real, join(root, "link"));
    return join(root, "link");
  };
  const scratch = (): string => join(root, "home/.pap/agents/.runs/atlas/t1");

  it("refuses a home that is a symlink or behind one, whatever the writable folder is", async () => {
    const link = plantLink();
    for (const home of [link, join(link, "sub")]) {
      for (const writable of [null, scratch()]) {
        spec = { ...spec, view: "system", home, writable };
        await expect(run()).rejects.toThrow(/the home is not a real folder/);
      }
      spec = { ...spec, view: "host", home, writable: home };
      await expect(run()).rejects.toThrow(/not a real folder/);
    }
    expect(spawned).toEqual([]);
  });

  it("refuses a writable folder that is a symlink or behind one", async () => {
    const link = plantLink();
    for (const writable of [link, join(link, "sub")]) {
      spec = { ...spec, view: "system", writable };
      await expect(run()).rejects.toThrow(/the writable folder is not a real folder/);
    }
    expect(spawned).toEqual([]);
  });

  it("refuses a home or writable folder that is missing or a file", async () => {
    writeFileSync(join(root, "file"), "x");
    spec = { ...spec, home: join(root, "file"), writable: join(root, "file") };
    await expect(run()).rejects.toThrow(/not a real folder/);
    spec = { ...spec, home: join(root, "missing"), writable: join(root, "missing") };
    await expect(run()).rejects.toThrow(/not a real folder/);
    expect(spawned).toEqual([]);
  });

  it("refuses a hidden folder that is a symlink or a file (bwrap would fail, or the link would be followed)", async () => {
    symlinkSync(join(root, "var-log"), join(root, "hide-link"));
    spec = { ...spec, hide: [...spec.hide, join(root, "hide-link")] };
    await expect(run()).rejects.toThrow(/hidden folder/);
    writeFileSync(join(root, "hide-file"), "x");
    spec = { ...spec, hide: [...spec.hide.slice(0, 3), join(root, "hide-file")] };
    await expect(run()).rejects.toThrow(/hidden folder/);
    expect(spawned).toEqual([]);
  });

  it("drops a hidden folder that does not exist (nothing is there to hide) and keeps the others", async () => {
    spec = { ...spec, hide: [...spec.hide, join(root, "no-such-folder")] };
    const done = run();
    spawned[0]?.child.emit("close", 0, null);
    await done;
    const kept = { ...spec, hide: spec.hide.slice(0, 3) };
    expect(spawned[0]?.argv).toEqual(bwrapArgv(kept, "echo hi"));
  });
});
