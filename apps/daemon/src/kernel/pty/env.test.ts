import { describe, expect, it } from "vitest";
import { workerEnv } from "../supervisor/env.ts";
import { shellEnv } from "./env.ts";

describe("shellEnv", () => {
  it("keeps the user's variables, drops the daemon's, and sets the terminal type", () => {
    expect(
      shellEnv({
        PATH: "/bin",
        HOME: "/h",
        PAP_SECRET: "x",
        NODE_OPTIONS: "--y",
        NOTIFY_SOCKET: "/run/x",
        LISTEN_FDS: "3",
        CREDENTIALS_DIRECTORY: "/run/c",
        LC_ALL: "fr_FR.UTF-8",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "fr_FR.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
  });

  it("sets LANG only when no locale variable is set, and overrides a TERM it was given", () => {
    expect(shellEnv({ PATH: "/bin", TERM: "dumb" })).toEqual({
      PATH: "/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
    });
    expect(shellEnv({ LANG: "en_US.UTF-8" }).LANG).toBe("en_US.UTF-8");
    expect(shellEnv({ LC_CTYPE: "C" }).LANG).toBeUndefined();
  });

  it("skips undefined values and does not change its input", () => {
    const base = { PAP_HOME: "/p", GONE: undefined, A: "b" };
    expect(shellEnv(base)).not.toHaveProperty("GONE");
    expect(base).toEqual({ PAP_HOME: "/p", GONE: undefined, A: "b" });
  });

  it("keeps a key iff workerEnv does (one shared rule)", () => {
    const keys = [
      "PATH",
      "HOME",
      "XDG_RUNTIME_DIR",
      "PAP_HOME",
      "PAP_X",
      "NODE_OPTIONS",
      "NOTIFY_SOCKET",
      "LISTEN_FDS",
      "LISTEN_PID",
      "LISTEN_FDNAMES",
      "INVOCATION_ID",
      "JOURNAL_STREAM",
      "SYSTEMD_EXEC_PID",
      "MANAGERPID",
      "MANAGERPIDFDID",
      "MAINPID",
      "WATCHDOG_PID",
      "WATCHDOG_USEC",
      "CREDENTIALS_DIRECTORY",
      "MEMORY_PRESSURE_WATCH",
      "MEMORY_PRESSURE_WRITE",
      "HTTPS_PROXY",
    ];
    const base = Object.fromEntries(keys.map((key) => [key, "v"]));
    const shell = shellEnv(base);
    const worker = workerEnv(base, {});
    for (const key of keys) expect(key in shell, key).toBe(key in worker);
    expect(Object.keys(shell).filter((key) => key.startsWith("PAP_"))).toEqual([]);
  });
});
