import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bwrapArgv, type SandboxSpec } from "@pap/contracts";
import { createSystemClock } from "../clock.ts";
import { probeSandbox, type SandboxProbe } from "./probe.ts";

// The real /usr/bin/bwrap in temporary folders. CI must provide a working bwrap; locally the file skips with one line.
const probe: SandboxProbe = await probeSandbox(undefined, { timers: createSystemClock() });
if (!probe.usable && process.env.CI)
  throw new Error("probe.int.test: CI must provide a working /usr/bin/bwrap");
if (!probe.usable) console.warn("probe.int.test: skipped: no usable /usr/bin/bwrap on this machine");

const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };

interface Ran {
  readonly code: number | null;
  readonly out: string;
}
const run = (
  spec: SandboxSpec,
  command: string,
  env: Record<string, string> = ENV,
  socket?: string,
): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.bwrap, bwrapArgv(spec, command, socket), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out }));
  });

describe.skipIf(!probe.usable)("the real bwrap", () => {
  // A fake owner home inside the checkout (node_modules/.cache), never in /tmp (bwrap's empty /tmp would hide it for the wrong reason).
  let base: string;
  let work: string;
  let hostMarker: string;
  const path = (...parts: string[]): string => join(base, ...parts);
  const specs = (): Record<"thread" | "task" | "precheck", SandboxSpec> => {
    const hide = [path("home"), path("home", ".pap"), path("home", ".pi", "agent"), "/var/log", "/var/tmp"];
    const bwrap = probe.usable ? probe.path : "/usr/bin/bwrap";
    const home = path("home", ".pap", "agents", "atlas");
    const thread: SandboxSpec = {
      bwrap,
      view: "host",
      home,
      writable: home,
      hide,
      network: false,
      egress: null,
    };
    const scratch = path("home", ".pap", "agents", ".runs", "atlas", "t1");
    return {
      thread,
      task: { ...thread, view: "system", writable: scratch },
      precheck: { ...thread, view: "system", writable: null },
    };
  };

  beforeAll(() => {
    const cache = fileURLToPath(new URL("../../../../../node_modules/.cache", import.meta.url));
    mkdirSync(cache, { recursive: true });
    base = mkdtempSync(join(cache, "pap-sandbox-int-"));
    expect(base.startsWith(tmpdir())).toBe(false);
    work = mkdtempSync(join(tmpdir(), "pap-sandbox-int-"));
    mkdirSync(path("home", ".ssh"), { recursive: true });
    writeFileSync(path("home", ".ssh", "id"), "PRIVATE-KEY");
    mkdirSync(path("home", ".pi", "agent"), { recursive: true });
    writeFileSync(path("home", ".pi", "agent", "auth.json"), "PROVIDER-KEY");
    mkdirSync(path("home", ".pap", "agents", "atlas"), { recursive: true });
    mkdirSync(path("home", ".pap", "agents", ".runs", "atlas", "t1"), { recursive: true });
    writeFileSync(path("home", ".pap", "state.db"), "DB");
    writeFileSync(path("home", ".pap", "agents", "atlas", "MEMORY.md"), "memory");
    mkdirSync(path("other"), { recursive: true });
    writeFileSync(path("other", "visible.txt"), "visible");
    hostMarker = join("/var/tmp", `pap-sandbox-int-${process.pid}`);
    writeFileSync(hostMarker, "host var/tmp file");
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    rmSync(hostMarker, { force: true });
  });

  it("the system probe is usable and leaves no canary folder", async () => {
    expect(probe).toEqual({ usable: true, path: expect.stringMatching(/^\/usr\/bin\//) });
    expect(await probeSandbox(undefined, { timers: createSystemClock(), tmp: work })).toEqual(probe);
    expect(readdirSync(work)).toEqual([]);
  });

  it("the canary is hidden whatever folder it is made in: usable with the canary outside /tmp", async () => {
    // Dropping the probe's `--tmpfs <canary folder>` leaves the canary visible here (/tmp is empty inside anyway).
    expect(await probeSandbox(undefined, { timers: createSystemClock(), tmp: path("other") })).toEqual(probe);
    expect(readdirSync(path("other"))).toEqual(["visible.txt"]);
  });

  describe("the thread view (host)", () => {
    it("sees the system and a folder outside the hidden ones, read-only", async () => {
      const { thread } = specs();
      const seen = await run(thread, `cat ${path("other", "visible.txt")}; touch ${path("other", "x")}`);
      expect(seen.out).toContain("visible");
      expect(seen.code).not.toBe(0);
      expect(existsSync(path("other", "x"))).toBe(false);
    });

    it("hides the owner's home, $PAP_HOME and Pi's folder, leaving the agent home as the only way through", async () => {
      const { thread } = specs();
      const seen = await run(
        thread,
        [
          `test ! -e ${path("home", ".ssh", "id")} && echo ssh-hidden`,
          `test ! -e ${path("home", ".pi", "agent", "auth.json")} && echo pi-hidden`,
          `test ! -e ${path("home", ".pap", "state.db")} && echo db-hidden`,
          `ls -A ${path("home")}`,
          `ls -A ${path("home", ".pap")}`,
          `ls -A ${path("home", ".pap", "agents")}`,
        ].join("; "),
      );
      expect(seen.out.split("\n")).toEqual([
        "ssh-hidden",
        "pi-hidden",
        "db-hidden",
        ".pap",
        ".pi",
        "agents",
        "atlas",
        "",
      ]);
    });

    it("writes its own folder (and only it), starting there", async () => {
      const { thread } = specs();
      const seen = await run(
        thread,
        `pwd; echo mine > note.txt; cat MEMORY.md; touch ${path("home", ".pap", "agents", "intruder")}`,
      );
      expect(seen.out.split("\n").slice(0, 2)).toEqual([thread.home, "memory"]);
      expect(readFileSync(join(thread.home, "note.txt"), "utf8")).toBe("mine\n");
      expect(existsSync(path("home", ".pap", "agents", "intruder"))).toBe(false);
    });

    it("hides /var/tmp and the journals", async () => {
      const { thread } = specs();
      expect(existsSync(hostMarker)).toBe(true);
      const seen = await run(
        thread,
        "ls -A /var/tmp; echo ==SEP==; journalctl --user -n 1 2>&1; ls /run/user 2>&1; ls /run",
      );
      const [varTmp, rest] = seen.out.split("==SEP==\n");
      expect(varTmp).toBe("");
      expect(rest).toContain("No journal files were found.");
      expect(rest).toContain("-- No entries --");
      expect(rest).toContain("ls: cannot access '/run/user': No such file or directory");
    });

    it("hides the host logs: /var/log/syslog (a copy of the journal, readable through the adm group) and the journal", async () => {
      const { thread } = specs();
      const seen = await run(
        thread,
        "test ! -e /var/log/syslog && test ! -e /var/log/journal && echo no-logs",
      );
      expect(seen.out).toBe("no-logs\n");
    });

    it("never has the host's network: lo only whether or not the spec asks, no resolver, only the proxy socket and forwarder bound (decision 90)", async (context) => {
      const { thread } = specs();
      const interfaces = "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '";
      const off = await run(thread, interfaces);
      expect(off.out).toBe("lo\n");
      const python = "/usr/bin/python3";
      if (!existsSync(python)) {
        if (process.env["CI"]) throw new Error("probe.int.test: CI must provide /usr/bin/python3");
        context.skip("no /usr/bin/python3 on this machine");
      }
      // A stand-in forwarder that starts and exits at once: the wrapper's contract is "ready when the interpreter returns".
      const forwarder = join(work, "fwd.py");
      writeFileSync(forwarder, "pass\n");
      const socket = join(work, "proxy.s");
      writeFileSync(socket, "");
      const on = await run(
        { ...thread, network: true, egress: { python, forwarder } },
        `${interfaces}; ls /run | sort; ls /run/systemd 2>&1 | head -1`,
        ENV,
        socket,
      );
      expect(on.out).toBe(
        "lo\npap-egress.sock\npap-fwd.py\nls: cannot access '/run/systemd': No such file or directory\n",
      );
    });

    it("holds fds 0 to 2 only, is in a session led by the sandbox's init (sid 1, never 0), and sees exactly the environment it was given", async () => {
      const { thread } = specs();
      const seen = await run(
        thread,
        'ls /proc/$$/fd; echo "sid=$(cut -d" " -f6 /proc/$$/stat) pid=$$"; env | sort',
        { ...ENV, FOO: "bar" },
      );
      const lines = seen.out.split("\n");
      expect(lines.slice(0, 3)).toEqual(["0", "1", "2"]);
      const [sid, pid] = (lines[3] ?? "").match(/\d+/g) ?? [];
      expect([sid, pid]).toEqual(["1", "2"]);
      expect(lines.slice(4)).toEqual([
        "FOO=bar",
        "LANG=C.UTF-8",
        `PATH=${ENV.PATH}`,
        `PWD=${thread.home}`,
        "",
      ]);
    });
  });

  describe("the system view (isolated task and precheck)", () => {
    it("sees the system folders only: no /srv, no /var/lib, no other folder of the machine", async () => {
      const { task } = specs();
      const seen = await run(
        task,
        `test -x /usr/bin/env && echo env; test ! -e /srv && echo no-srv; test ! -e /var/lib && echo no-var-lib; test ! -e ${path("other", "visible.txt")} && echo no-other; test ! -e ${path("home", ".ssh")} && echo no-ssh; test ! -e ${path("home", ".pap", "state.db")} && echo no-db`,
      );
      expect(seen.out).toBe("env\nno-srv\nno-var-lib\nno-other\nno-ssh\nno-db\n");
    });

    it("reads its home but writes its scratch folder only, starting there", async () => {
      const { task } = specs();
      const scratch = task.writable ?? "";
      const seen = await run(
        task,
        `pwd; echo "[$(cat ${task.home}/MEMORY.md)]"; echo x >> ${task.home}/MEMORY.md; touch ${task.home}/x; touch ${scratch}/x && echo scratch-ok`,
      );
      expect(seen.out).toContain(`${scratch}\n[memory]\n`);
      expect(seen.out).toContain("scratch-ok");
      expect(readFileSync(join(task.home, "MEMORY.md"), "utf8")).toBe("memory");
      expect(existsSync(join(task.home, "x"))).toBe(false);
      expect(existsSync(join(scratch, "x"))).toBe(true);
    });

    it("a precheck writes nothing and starts in the home", async () => {
      const { precheck } = specs();
      const seen = await run(precheck, `pwd; touch ${precheck.home}/x`);
      expect(seen.out.split("\n")[0]).toBe(precheck.home);
      expect(seen.code).not.toBe(0);
      expect(existsSync(join(precheck.home, "x"))).toBe(false);
    });

    it("has no /run/user, and nothing of the host's /var/tmp or journals either", async () => {
      const { task } = specs();
      const seen = await run(
        task,
        'test ! -e /run/user && echo no-run-user; echo "[$(ls -A /var/tmp /var/log 2>&1)]"',
      );
      expect(seen.out).toBe("no-run-user\n[/var/log:\n\n/var/tmp:]\n");
    });
  });

  it("is in a pid namespace of its own: the shell is one of the first processes", async () => {
    const { thread } = specs();
    const seen = await run(thread, "echo $$");
    expect(seen.out).toBe("2\n");
  });

  const countSleepers = (seconds: string): number =>
    readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .filter((entry) => {
        try {
          return readFileSync(`/proc/${entry}/cmdline`, "utf8") === `sleep\0${seconds}\0`;
        } catch {
          return false;
        }
      }).length;

  it("--die-with-parent: killing bwrap alone (not its group) takes the sandbox down", async () => {
    const { thread } = specs();
    const seconds = String(4_000 + (process.pid % 1_000));
    const child = spawn(thread.bwrap, bwrapArgv(thread, `sleep ${seconds} & wait`), {
      env: ENV,
      stdio: "ignore",
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      await vi.waitFor(() => expect(countSleepers(seconds)).toBe(1), { timeout: 10_000 });
      child.kill("SIGKILL");
      await closed;
      await vi.waitFor(() => expect(countSleepers(seconds)).toBe(0), { timeout: 10_000 });
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a group SIGKILL leaves no process: two background sleeps are gone", async () => {
    const { thread } = specs();
    const seconds = String(3_000 + (process.pid % 1_000));
    const sleepers = (): number => countSleepers(seconds);
    const child = spawn(thread.bwrap, bwrapArgv(thread, `sleep ${seconds} & sleep ${seconds} & wait`), {
      env: ENV,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      await vi.waitFor(() => expect(sleepers()).toBe(2), { timeout: 10_000 });
      expect(child.pid).toBeGreaterThan(1);
      process.kill(-(child.pid ?? 0), "SIGKILL");
      await closed;
      await vi.waitFor(() => expect(sleepers()).toBe(0), { timeout: 10_000 });
    } finally {
      if (child.pid !== undefined && child.pid > 1) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});
