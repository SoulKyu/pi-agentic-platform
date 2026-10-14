import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { shellEnv } from "./env.ts";
import { parseProcStat, ptyKill, sessionMembers } from "./kill.ts";
import { loadNodePty } from "./load.ts";
import { ptySpec, type PtyProcess, spawnPty } from "./spawn.ts";

// dash and bash keep a copy of their terminal, opened through /dev/tty (the same device as the pts they run on).
const TERMINAL = /^\/dev\/(?:pts\/\d+|tty)$/;
const WAIT = { timeout: 15_000, interval: 25 } as const;
let home: string;
let cwd: string;
const open: PtyProcess[] = [];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pap-pty-")));
  cwd = join(home, "work");
  mkdirSync(cwd);
  // zsh asks its first-run questions in a home without a .zshrc.
  writeFileSync(join(home, ".zshrc"), "");
});
afterEach(async () => {
  for (const pty of open.splice(0)) {
    await ptyKill(pty, { clock: createSystemClock(), warn: () => {} });
  }
  rmSync(home, { recursive: true, force: true });
});

const alive = async (pid: number): Promise<boolean> => {
  try {
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
};

function terminal(shell: string, size = { cols: 80, rows: 24 }, umask = 0o022) {
  const pty = loadNodePty(silentLogger);
  if (pty === null) throw new Error("node-pty did not load");
  const env = shellEnv({
    PATH: process.env.PATH,
    HOME: home,
    SHELL: shell,
    PAP_SECRET_X: "s3cret",
    NOTIFY_SOCKET: "/run/x",
  });
  const proc = spawnPty(pty, ptySpec({ shell, cwd, ...size, env, scope: null, umask }), silentLogger);
  open.push(proc);
  let output = "";
  proc.onData((chunk) => {
    output += chunk.toString("utf8");
  });
  return {
    proc,
    output: () => output,
    type: (text: string) => proc.write(Buffer.from(text)),
  };
}

describe("a real terminal on /bin/sh", () => {
  it("runs typed commands in the judged folder, with the typed size and without the daemon's variables", async () => {
    const t = terminal("/bin/sh");
    t.type("echo pap-$((6*7))\r");
    await vi.waitFor(() => expect(t.output()).toContain("pap-42"), WAIT);
    t.type("stty size\r");
    await vi.waitFor(() => expect(t.output()).toContain("24 80\r\n"), WAIT);
    t.proc.resize(100, 30);
    t.type("stty size\r");
    await vi.waitFor(() => expect(t.output()).toContain("30 100\r\n"), WAIT);
    t.type('echo "[$PAP_SECRET_X][$NOTIFY_SOCKET]"\r');
    await vi.waitFor(() => expect(t.output()).toContain("[][]\r\n"), WAIT);
    t.type("pwd\r");
    await vi.waitFor(() => expect(t.output()).toContain(`${cwd}\r\n`), WAIT);
    expect(t.output()).not.toContain("s3cret");
  });

  it("starts under the umask it is given, not the daemon's own 077", async () => {
    const before = process.umask(0o077);
    try {
      const t = terminal("/bin/sh", undefined, 0o002);
      t.type("umask\r");
      await vi.waitFor(() => expect(t.output()).toContain("0002\r\n"), WAIT);
      expect(process.umask()).toBe(0o077);
    } finally {
      process.umask(before);
    }
  });

  it("reports the signal that ended the shell by name", async () => {
    const t = terminal("/bin/sh");
    t.type("kill -9 $$\r");
    expect(await t.proc.exited).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("raises the shell's oom_score_adj to 800 and records the /proc start it will be killed by", () => {
    const t = terminal("/bin/sh");
    expect(readFileSync(`/proc/${t.proc.pid}/oom_score_adj`, "utf8").trim()).toBe("800");
    expect(t.proc.start).toBe(
      parseProcStat(t.proc.pid, readFileSync(`/proc/${t.proc.pid}/stat`, "utf8"))?.start,
    );
  });

  it("holds no descriptor of the daemon: every descriptor of the shell is the terminal (M8R119)", async () => {
    const t = terminal("/bin/sh");
    t.type("echo ready-$((1+1))\r");
    await vi.waitFor(() => expect(t.output()).toContain("ready-2"), WAIT);
    const links = readdirSync(`/proc/${t.proc.pid}/fd`).map((fd) =>
      readlinkSync(`/proc/${t.proc.pid}/fd/${fd}`),
    );
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) expect(link).toMatch(TERMINAL);
    t.type('echo FD-BEGIN-$((1+1)); for f in /proc/$$/fd/*; do readlink "$f"; done; echo FD-END-$((1+1))\r');
    await vi.waitFor(() => expect(t.output()).toContain("FD-END-2\r\n"), WAIT);
    const seen = t.output().split("FD-BEGIN-2\r\n")[1]?.split("FD-END-2")[0]?.trim().split("\r\n") ?? [];
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const line of seen) expect(line).toMatch(TERMINAL);
  });
});

const SHELLS = ["/bin/sh", "/bin/bash", "/usr/bin/zsh"].filter((shell) => existsSync(shell));

describe.each(SHELLS)("closing a terminal on %s (M8R55, RT-05)", (shell) => {
  it("kills the shell, a job that ignores SIGHUP and the foreground command, whatever their process groups", async () => {
    const t = terminal(shell);
    t.type('trap "" HUP; echo $$ > shell.pid; sleep 1000 & echo $! > job.pid; sleep 1001\r');
    await vi.waitFor(() => {
      expect(Number(readFileSync(join(cwd, "job.pid"), "utf8"))).toBeGreaterThan(1);
    }, WAIT);
    const job = Number(readFileSync(join(cwd, "job.pid"), "utf8"));
    await vi.waitFor(
      () => expect(Number(readFileSync(join(cwd, "shell.pid"), "utf8"))).toBe(t.proc.pid),
      WAIT,
    );
    const members = await sessionMembers(t.proc, {
      entry: async (pid) => {
        try {
          return parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
        } catch {
          return null;
        }
      },
      pids: async () =>
        readdirSync("/proc")
          .filter((n) => /^\d+$/.test(n))
          .map(Number),
    });
    expect(members).toContain(job);
    expect(members?.length).toBeGreaterThanOrEqual(2);
    await ptyKill(t.proc, { clock: createSystemClock(), warn: () => {} });
    await vi.waitFor(async () => {
      for (const pid of [t.proc.pid, ...(members ?? [])]) expect(await alive(pid), String(pid)).toBe(false);
    }, WAIT);
  });
});
