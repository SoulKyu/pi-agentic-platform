import { describe, expect, it } from "vitest";
import { isDaemonOnly, workerEnv } from "./env.ts";

describe("workerEnv", () => {
  it("drops PAP_* variables, disables Pi telemetry and the version check, applies extras", () => {
    const env = workerEnv(
      { PATH: "/usr/bin", PAP_HOME: "/secret", PAP_TEST_PROVIDER_SCRIPT: "/s.json", HOME: "/home/u" },
      { PI_CODING_AGENT_DIR: "/agent" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      PI_CODING_AGENT_DIR: "/agent",
    });
  });

  it("overrides what the daemon was started with, and lets only a caller bring PAP_TEST_PROVIDER back", () => {
    const base = {
      PAP_TEST_PROVIDER: "1",
      PI_TELEMETRY: "1",
      PI_SKIP_VERSION_CHECK: "0",
      KEEP: "yes",
      GONE: undefined,
    };
    expect(workerEnv(base, {})).toEqual({ PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", KEEP: "yes" });
    expect(workerEnv(base, { PAP_TEST_PROVIDER: "1" })).toMatchObject({ PAP_TEST_PROVIDER: "1" });
  });

  it("does not change the environment it was given", () => {
    const base = { PAP_HOME: "/secret", PATH: "/usr/bin" };
    workerEnv(base, { A: "b" });
    expect(base).toEqual({ PAP_HOME: "/secret", PATH: "/usr/bin" });
  });

  it("drops the daemon's NODE_OPTIONS, which would load code into every worker, but keeps the rest", () => {
    const env = workerEnv(
      { NODE_OPTIONS: "--require /x.js", LD_LIBRARY_PATH: "/lib", HTTPS_PROXY: "http://p", PATH: "/usr/bin" },
      {},
    );
    expect(env).toEqual({
      LD_LIBRARY_PATH: "/lib",
      HTTPS_PROXY: "http://p",
      PATH: "/usr/bin",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
  });

  it("lets a caller set NODE_OPTIONS for one worker, but never turn telemetry or the version check back on", () => {
    const env = workerEnv(
      {},
      { NODE_OPTIONS: "--max-old-space-size=256", PI_TELEMETRY: "1", PI_SKIP_VERSION_CHECK: "0" },
    );
    expect(env).toEqual({
      NODE_OPTIONS: "--max-old-space-size=256",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
  });

  it("drops the service manager's variables of the daemon's own unit and keeps PATH and XDG_RUNTIME_DIR", () => {
    const platform = [
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
    ];
    const base = Object.fromEntries([
      ...platform.map((key) => [key, "x"]),
      ["PAP_X", "x"],
      ["NODE_OPTIONS", "--y"],
      ["PATH", "/usr/bin"],
      ["XDG_RUNTIME_DIR", "/run/user/1000"],
    ]);
    for (const key of platform) expect(isDaemonOnly(key), key).toBe(true);
    expect(workerEnv(base, {})).toEqual({
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
  });
});
