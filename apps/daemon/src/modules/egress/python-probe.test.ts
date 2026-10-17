import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { TrustOps } from "../../kernel/sandbox/probe.ts";
import { PYTHON_CANDIDATES, probePython } from "./python-probe.ts";

type Over = Record<string, { uid?: number; mode?: number }>;

/** `present` maps a candidate to its real path; `over` changes the owner or mode of a path (root 0755 by default). */
const opsOf = (present: Record<string, string>, over: Over = {}): TrustOps => ({
  realpath(path) {
    const real = present[path];
    if (real === undefined) throw new Error("ENOENT");
    return real;
  },
  stat: (path) => ({
    uid: over[path]?.uid ?? 0,
    mode: over[path]?.mode ?? 0o755,
    isFile: () => Object.values(present).includes(path),
  }),
});

type Spawned = { file: string; args: string[] };
function spawnOf(output: (nonce: string) => string | null, spawned: Spawned[] = [], kills: string[] = []) {
  const spawn = ((file: string, args: string[]) => {
    spawned.push({ file, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      pid: 0,
      kill: (signal: string) => kills.push(signal),
    });
    const nonce = /print\('([0-9a-f]+)'\)/.exec(args[3] ?? "")?.[1] ?? "";
    const text = output(nonce);
    if (text !== null)
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(text));
        child.emit("close", 0);
      });
    return child;
  }) as never;
  return spawn;
}

const good = { "/usr/bin/python3": "/usr/bin/python3.14" };

describe("probePython (M11R242)", () => {
  it("names the three candidates in order", () => {
    expect(PYTHON_CANDIDATES).toEqual(["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"]);
  });

  it("takes the first usable candidate and runs it once in isolated mode", async () => {
    const spawned: Spawned[] = [];
    const result = await probePython({
      clock: createFakeClock(),
      ops: opsOf(good),
      spawn: spawnOf((nonce) => `${nonce}\n`, spawned),
    });
    expect(result).toEqual({ usable: true, python: "/usr/bin/python3.14", reason: null });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.file).toBe("/usr/bin/python3.14");
    expect(spawned[0]?.args.slice(0, 3)).toEqual(["-I", "-S", "-c"]);
  });

  it("a user-owned python3 is unsafe_path and is never run", async () => {
    const spawned: Spawned[] = [];
    const result = await probePython({
      clock: createFakeClock(),
      ops: opsOf({ "/usr/bin/python3": "/usr/bin/python3" }, { "/usr/bin/python3": { uid: 1000 } }),
      spawn: spawnOf((nonce) => nonce, spawned),
    });
    expect(result).toEqual({ usable: false, python: null, reason: "unsafe_path" });
    expect(spawned).toEqual([]);
  });

  it("a group-writable folder above it is unsafe_path", async () => {
    const result = await probePython({
      clock: createFakeClock(),
      ops: opsOf(good, { "/usr/bin": { mode: 0o775 } }),
      spawn: spawnOf((nonce) => nonce),
    });
    expect(result.reason).toBe("unsafe_path");
  });

  it("a real path outside SYSTEM_FOLDERS is unsafe_path, because the system view would not show it", async () => {
    const result = await probePython({
      clock: createFakeClock(),
      ops: opsOf({ "/usr/local/bin/python3": "/srv/py/bin/python3" }),
      spawn: spawnOf((nonce) => nonce),
    });
    expect(result).toEqual({ usable: false, python: null, reason: "unsafe_path" });
  });

  it("falls to the next candidate when the first is unsafe", async () => {
    const result = await probePython({
      clock: createFakeClock(),
      ops: opsOf(
        { "/usr/bin/python3": "/usr/bin/python3", "/bin/python3": "/usr/bin/python3.12" },
        { "/usr/bin/python3": { uid: 1000 } },
      ),
      spawn: spawnOf((nonce) => nonce),
    });
    expect(result).toEqual({ usable: true, python: "/usr/bin/python3.12", reason: null });
  });

  it("none present is no_python", async () => {
    const result = await probePython({
      clock: createFakeClock(),
      ops: opsOf({}),
      spawn: spawnOf(() => null),
    });
    expect(result).toEqual({ usable: false, python: null, reason: "no_python" });
  });

  it("a wrong nonce is no_python", async () => {
    const result = await probePython({
      clock: createFakeClock(),
      ops: opsOf(good),
      spawn: spawnOf(() => "something else"),
    });
    expect(result).toEqual({ usable: false, python: null, reason: "no_python" });
  });

  it("gives up after 5 s on the kernel clock and kills the process", async () => {
    const clock = createFakeClock();
    const kills: string[] = [];
    const pending = probePython({ clock, ops: opsOf(good), spawn: spawnOf(() => null, [], kills) });
    await clock.advance(4999);
    expect(kills).toEqual([]);
    await clock.advance(2);
    expect(await pending).toEqual({ usable: false, python: null, reason: "no_python" });
    expect(kills).toEqual(["SIGKILL"]);
  });
});
