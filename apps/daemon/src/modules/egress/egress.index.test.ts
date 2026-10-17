import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { type Egress, createEgress } from "./index.ts";
import { FORWARDER_SOURCE } from "./forwarder.ts";
import { scopeOf } from "./testing/bed.ts";

const USABLE = { usable: true, python: "/usr/bin/python3.14", reason: null } as const;
let tmp: string;
let egress: Egress;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "egi-"));
});
afterEach(async () => {
  await egress.dropSession("s1");
  rmSync(tmp, { recursive: true, force: true });
});

const make = (
  over: {
    papHome?: string;
    probe?: () => Promise<typeof USABLE | { usable: false; python: null; reason: "no_python" }>;
  } = {},
) => {
  const { logger, lines } = captureLogger();
  egress = createEgress({
    clock: createFakeClock(),
    logger,
    papHome: over.papHome ?? tmp,
    runtimeDir: undefined,
    probe: over.probe ?? (async () => USABLE),
  });
  return { lines };
};

describe("createEgress", () => {
  it("is unusable until the boot has run, then reports the interpreter", async () => {
    make();
    expect(egress.status()).toEqual({ usable: false, python: null, reason: "no_python" });
    await egress.bootClean();
    expect(egress.status()).toEqual(USABLE);
  });

  it("ready settles when the boot has run, and resolves at once before any boot", async () => {
    make();
    await egress.ready();
    expect(egress.status().usable).toBe(false);
    let settled = false;
    const booting = egress.bootClean();
    void egress.ready().then(() => (settled = true));
    await booting;
    await egress.ready();
    expect(settled).toBe(true);
    expect(egress.status()).toEqual(USABLE);
  });

  it("a probe that throws leaves the proxy unusable and the boot settled, never an unhandled rejection", async () => {
    const { lines } = make({
      probe: async () => {
        throw new Error("spawn exploded");
      },
    });
    await expect(egress.bootClean()).resolves.toBeUndefined();
    await expect(egress.ready()).resolves.toBeUndefined();
    expect(egress.status()).toEqual({ usable: false, python: null, reason: "no_python" });
    expect(lines.some((line) => line["msg"] === "egress_probe_failed")).toBe(true);
    await expect(egress.recheck()).resolves.toBeUndefined();
  });

  it("writes the forwarder once at boot, 0400, and names it", async () => {
    make();
    await egress.bootClean();
    const path = egress.forwarderPath;
    expect(path).toBe(join(tmp, "run", "egress", "fwd.py"));
    expect(readFileSync(path ?? "", "utf8")).toBe(FORWARDER_SOURCE);
    expect(statSync(path ?? "").mode & 0o777).toBe(0o400);
  });

  it("opens a command's socket inside its session folder, with short base-36 keys", async () => {
    make();
    await egress.bootClean();
    const opened = await egress.openCommand(scopeOf());
    if (!("socket" in opened)) throw new Error("not opened");
    expect(opened.socket).toMatch(new RegExp(`^${tmp}/run/egress/[0-9a-z]{1,6}/[0-9a-z]{1,6}\\.s$`));
    expect(Buffer.byteLength(opened.socket)).toBeLessThanOrEqual(107);
    expect(opened.id).toMatch(/^[0-9a-z]{1,6}$/);
    expect(statSync(opened.socket).mode & 0o777).toBe(0o600);
    const second = await egress.openCommand(scopeOf());
    if (!("socket" in second)) throw new Error("not opened");
    expect(second.socket.split("/").at(-2)).toBe(opened.socket.split("/").at(-2));
    expect(second.id).not.toBe(opened.id);
    const other = await egress.openCommand(scopeOf({ sessionId: "s2" }));
    if (!("socket" in other)) throw new Error("not opened");
    expect(other.socket.split("/").at(-2)).not.toBe(opened.socket.split("/").at(-2));
    await egress.dropSession("s2");
  });

  it("refuses the 9th open command of a session, and a closed one frees its slot", async () => {
    make();
    await egress.bootClean();
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const opened = await egress.openCommand(scopeOf());
      if (!("id" in opened)) throw new Error("not opened");
      ids.push(opened.id);
    }
    expect(await egress.openCommand(scopeOf())).toEqual({ reason: "limit" });
    expect(await egress.openCommand(scopeOf({ sessionId: "s2" }))).toHaveProperty("socket");
    await egress.dropSession("s2");
    await egress.closeCommand("s1", ids[0] ?? "");
    expect(await egress.openCommand(scopeOf())).toHaveProperty("socket");
  });

  it("is unavailable when the interpreter is not usable, or before the boot", async () => {
    make({ probe: async () => ({ usable: false, python: null, reason: "no_python" }) });
    expect(await egress.openCommand(scopeOf())).toEqual({ reason: "unavailable" });
    await egress.bootClean();
    expect(await egress.openCommand(scopeOf())).toEqual({ reason: "unavailable" });
    expect(egress.status()).toEqual({ usable: false, python: null, reason: "no_python" });
  });

  it("is unusable with socket_path when no root is short enough", async () => {
    const long = join(tmp, "p".repeat(90));
    make({ papHome: long });
    await egress.bootClean();
    expect(egress.status()).toEqual({ usable: false, python: "/usr/bin/python3.14", reason: "socket_path" });
    expect(egress.forwarderPath).toBeNull();
    expect(await egress.openCommand(scopeOf())).toEqual({ reason: "unavailable" });
  });

  it("recheck probes again", async () => {
    let usable = false;
    make({ probe: async () => (usable ? USABLE : { usable: false, python: null, reason: "no_python" }) });
    await egress.bootClean();
    expect(egress.status().usable).toBe(false);
    usable = true;
    await egress.recheck();
    expect(egress.status()).toEqual(USABLE);
  });

  it("recheck makes the root again after a boot that could not, and the boot log says why", async () => {
    writeFileSync(join(tmp, "run"), "in the way");
    const { lines } = make();
    await egress.bootClean();
    expect(egress.status()).toEqual({ usable: false, python: "/usr/bin/python3.14", reason: "socket_path" });
    expect(lines.find((line) => line["msg"] === "egress_root_unusable")).toMatchObject({
      reason: "not_a_folder",
    });
    rmSync(join(tmp, "run"));
    await egress.recheck();
    expect(egress.status()).toEqual(USABLE);
    expect(egress.forwarderPath).toBe(join(tmp, "run", "egress", "fwd.py"));
    expect(await egress.openCommand(scopeOf())).toHaveProperty("socket");
  });

  it("closeCommand answers the command's report; an unknown or closed one answers a truncated report", async () => {
    make();
    await egress.bootClean();
    const opened = await egress.openCommand(scopeOf());
    if (!("id" in opened)) throw new Error("not opened");
    expect(await egress.closeCommand("s1", opened.id)).toEqual({
      hosts: [],
      truncated: false,
      up: 0,
      down: 0,
    });
    expect(existsSync(opened.socket)).toBe(false);
    // A report that is missing is never a clean one (M11R233): the caller taints.
    expect(await egress.closeCommand("s1", "nope")).toEqual({ hosts: [], truncated: true, up: 0, down: 0 });
    expect(await egress.closeCommand("s1", opened.id)).toMatchObject({ truncated: true });
    expect(await egress.closeCommand("gone", "0")).toMatchObject({ truncated: true });
  });

  it("dropSession closes the session's commands and removes its folder only", async () => {
    make();
    await egress.bootClean();
    const mine = await egress.openCommand(scopeOf());
    const theirs = await egress.openCommand(scopeOf({ sessionId: "s2" }));
    if (!("socket" in mine) || !("socket" in theirs)) throw new Error("not opened");
    await egress.dropSession("s1");
    expect(existsSync(mine.socket)).toBe(false);
    expect(existsSync(join(mine.socket, ".."))).toBe(false);
    expect(existsSync(theirs.socket)).toBe(true);
    await egress.dropSession("s2");
  });

  it("a precheck (no session) gets a folder that goes with its last command", async () => {
    make();
    await egress.bootClean();
    const opened = await egress.openCommand(scopeOf({ sessionId: null }));
    if (!("id" in opened)) throw new Error("not opened");
    const root = join(tmp, "run", "egress");
    expect(readdirSync(root).filter((name) => name !== "fwd.py")).toHaveLength(1);
    await egress.closeCommand(scopeOf({ sessionId: null }), opened.id);
    expect(readdirSync(root)).toEqual(["fwd.py"]);
  });

  it("a session dropped with its commands open answers truncated for them afterwards", async () => {
    make();
    await egress.bootClean();
    const opened = await egress.openCommand(scopeOf());
    if (!("id" in opened)) throw new Error("not opened");
    await egress.dropSession("s1");
    expect(await egress.closeCommand("s1", opened.id)).toMatchObject({ truncated: true });
  });

  it("two daemons with different PAP_HOME and one XDG_RUNTIME_DIR never share or delete sockets (W5-R42)", async () => {
    const runtime = join(tmp, "xdg");
    mkdirSync(runtime, { mode: 0o700 });
    const build = (home: string) =>
      createEgress({
        clock: createFakeClock(),
        logger: captureLogger().logger,
        papHome: home,
        runtimeDir: runtime,
        probe: async () => USABLE,
      });
    mkdirSync(join(tmp, "a"));
    mkdirSync(join(tmp, "b"));
    const first = build(join(tmp, "a"));
    const second = build(join(tmp, "b"));
    await first.bootClean();
    const opened = await first.openCommand(scopeOf());
    if (!("socket" in opened)) throw new Error("not opened");
    await second.bootClean();
    expect(existsSync(opened.socket)).toBe(true);
    const other = await second.openCommand(scopeOf());
    if (!("socket" in other)) throw new Error("not opened");
    expect(other.socket.startsWith(runtime)).toBe(true);
    expect(other.socket.split("/").slice(0, -2).join("/")).not.toBe(
      opened.socket.split("/").slice(0, -2).join("/"),
    );
    await first.dropSession("s1");
    await second.dropSession("s1");
    egress = first;
  });

  it("a trailing slash on XDG_RUNTIME_DIR changes nothing", async () => {
    const runtime = join(tmp, "xdg");
    mkdirSync(runtime, { mode: 0o700 });
    egress = createEgress({
      clock: createFakeClock(),
      logger: captureLogger().logger,
      papHome: join(tmp, "home"),
      runtimeDir: `${runtime}//`,
      probe: async () => USABLE,
    });
    mkdirSync(join(tmp, "home"));
    await egress.bootClean();
    expect(egress.status()).toEqual(USABLE);
    expect(egress.forwarderPath?.startsWith(`${runtime}/pap/`)).toBe(true);
  });

  it("shutdown removes this daemon's folders under the runtime folder, forwarder included, and no one else's", async () => {
    const runtime = join(tmp, "xdg");
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(join(tmp, "a"));
    mkdirSync(join(tmp, "b"));
    const build = (home: string) =>
      createEgress({
        clock: createFakeClock(),
        logger: captureLogger().logger,
        papHome: home,
        runtimeDir: runtime,
        probe: async () => USABLE,
      });
    const first = build(join(tmp, "a"));
    const second = build(join(tmp, "b"));
    await first.bootClean();
    await second.bootClean();
    const opened = await first.openCommand(scopeOf());
    if (!("socket" in opened)) throw new Error("not opened");
    await first.shutdown();
    expect(existsSync(opened.socket)).toBe(false);
    expect(readdirSync(join(runtime, "pap"))).toHaveLength(1);
    expect(existsSync(second.forwarderPath ?? "")).toBe(true);
    await second.shutdown();
    // The shared `pap` folder stays: removing it could race another daemon's `prepareRoot`.
    expect(readdirSync(join(runtime, "pap"))).toEqual([]);
    egress = first;
  });

  it("shutdown refuses new commands at once, and a failure to remove the folder is logged, never thrown", async () => {
    const runtime = join(tmp, "xdg");
    mkdirSync(runtime, { mode: 0o700 });
    const { logger, lines } = captureLogger();
    egress = createEgress({
      clock: createFakeClock(),
      logger,
      papHome: tmp,
      runtimeDir: runtime,
      probe: async () => USABLE,
    });
    await egress.bootClean();
    const opened = await egress.openCommand(scopeOf());
    if (!("socket" in opened)) throw new Error("not opened");
    const closing = egress.shutdown();
    // Set before the sessions are closed: a recheck in between cannot make the root again.
    await egress.recheck();
    await closing;
    expect(existsSync(join(runtime, "pap", readdirSync(join(runtime, "pap"))[0] ?? "x", "egress"))).toBe(
      false,
    );
    // A root that cannot be removed (its parent is read-only) logs a line and the stop chain goes on.
    egress = createEgress({
      clock: createFakeClock(),
      logger,
      papHome: join(tmp, "other"),
      runtimeDir: runtime,
      probe: async () => USABLE,
    });
    mkdirSync(join(tmp, "other"));
    await egress.bootClean();
    const rootDir = join(egress.forwarderPath ?? "", "..");
    chmodSync(rootDir, 0o500);
    await expect(egress.shutdown()).resolves.toBeUndefined();
    chmodSync(rootDir, 0o700);
    expect(lines.some((line) => line["msg"] === "egress_shutdown_failed")).toBe(true);
  });

  it("normalises XDG_RUNTIME_DIR with path.resolve, dot segments included", async () => {
    const runtime = join(tmp, "xdg");
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(join(tmp, "home"));
    egress = createEgress({
      clock: createFakeClock(),
      logger: captureLogger().logger,
      papHome: join(tmp, "home"),
      runtimeDir: `${tmp}/./xdg/../xdg/`,
      probe: async () => USABLE,
    });
    await egress.bootClean();
    expect(egress.status()).toEqual(USABLE);
    expect(egress.forwarderPath?.startsWith(`${runtime}/pap/`)).toBe(true);
  });

  it("shutdown leaves a root under PAP_HOME alone", async () => {
    make();
    await egress.bootClean();
    await egress.shutdown();
    expect(existsSync(egress.forwarderPath ?? "")).toBe(true);
  });

  it("bootClean removes what a dead daemon left", async () => {
    make();
    await egress.bootClean();
    const opened = await egress.openCommand(scopeOf());
    if (!("socket" in opened)) throw new Error("not opened");
    const again = createEgress({
      clock: createFakeClock(),
      logger: captureLogger().logger,
      papHome: tmp,
      runtimeDir: undefined,
      probe: async () => USABLE,
    });
    await again.bootClean();
    expect(existsSync(opened.socket)).toBe(false);
    expect(readdirSync(join(tmp, "run", "egress"))).toEqual(["fwd.py"]);
  });
});
