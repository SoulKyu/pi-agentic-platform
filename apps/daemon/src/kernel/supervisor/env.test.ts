import { describe, expect, it } from "vitest";
import { workerEnv } from "./env.ts";

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
});
