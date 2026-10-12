import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  defaultMaxWorkers,
  loadConfig,
  WORKER_BUDGET_MB,
  workerExecArgv,
  type ConfigInput,
} from "./config.ts";

let cwd: string;
let base: ConfigInput;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pap-config-"));
  base = {
    argv: [],
    env: {},
    cwd,
    homedir: "/home/u",
    totalMemMb: 16_384,
    piHostEntry: "/x/main.js",
    piHostExecArgv: [],
    staticRoot: null,
  };
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("loadConfig", () => {
  it("binds 127.0.0.1:7777 with ~/.pap and ~/.pi/agent by default", () => {
    const config = loadConfig(base);
    expect([config.host, config.port, config.home, config.piAgentDir]).toEqual([
      "127.0.0.1",
      7777,
      "/home/u/.pap",
      "/home/u/.pi/agent",
    ]);
    expect(config.tls).toBeNull();
  });

  it("loopback hosts publish a localhost origin and accept the loopback aliases", () => {
    const config = loadConfig(base);
    expect(config.publicOrigin).toBe("http://localhost:7777");
    expect([...config.allowedOrigins]).toEqual(
      expect.arrayContaining(["http://localhost:7777", "http://127.0.0.1:7777", "http://[::1]:7777"]),
    );
  });

  it("--dev derives a stable port and PAP_HOME from the worktree path", () => {
    const a = loadConfig({ ...base, argv: ["--dev"] });
    const b = loadConfig({ ...base, argv: ["--dev"] });
    expect(a.port).toBe(b.port);
    expect(a.port).toBeGreaterThanOrEqual(20_000);
    expect(a.port).toBeLessThan(30_000);
    expect(a.home.startsWith("/home/u/.pap-dev/")).toBe(true);
    expect(a.allowedOrigins.has("http://localhost:5173")).toBe(true);
  });

  it("requires --tls-cert and --tls-key together", () => {
    expect(() => loadConfig({ ...base, argv: ["--tls-cert", "/c.pem"] })).toThrow(ConfigError);
  });

  it("rejects bad ports, relative test scripts and unknown flags", () => {
    expect(() => loadConfig({ ...base, argv: ["--port", "70000"] })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, env: { PAP_TEST_PROVIDER_SCRIPT: "script.json" } })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, argv: ["--bogus"] })).toThrow();
  });

  it("allows a session cookie without Secure on plain HTTP only with --insecure-http", () => {
    expect(loadConfig(base).insecureHttp).toBe(false);
    const lan = loadConfig({ ...base, argv: ["--host", "192.168.1.182", "--insecure-http"] });
    expect(lan.insecureHttp).toBe(true);
    expect(lan.publicOrigin).toBe("http://192.168.1.182:7777");
    expect(() =>
      loadConfig({ ...base, argv: ["--insecure-http", "--tls-cert", "/c.pem", "--tls-key", "/k.pem"] }),
    ).toThrow(ConfigError);
  });

  it("uses PAP_PUBLIC_ORIGIN for a non-loopback host", () => {
    const config = loadConfig({
      ...base,
      argv: ["--host", "0.0.0.0"],
      env: { PAP_PUBLIC_ORIGIN: "https://pap.example.ts.net" },
    });
    expect(config.publicOrigin).toBe("https://pap.example.ts.net");
    expect(config.allowedOrigins.has("https://pap.example.ts.net")).toBe(true);
  });

  it("forwards the development condition to the workers and no --import, whatever the daemon was given (R130)", () => {
    // A worker runs in the session's project: a relative or bare specifier would load that project's code first.
    expect(
      workerExecArgv([
        "--disable-warning=ExperimentalWarning",
        "--conditions=development",
        "--import=./x.mjs",
        "--import=pkg/register",
        "--import=/abs/guard.ts",
        "--import",
        "/not/forwarded.ts",
        "--max-old-space-size=64",
        "--conditions",
        "development",
        "--conditionsX=1",
      ]),
    ).toEqual(["--conditions=development", "--max-semi-space-size=16"]);
    expect(workerExecArgv([])).toEqual(["--max-semi-space-size=16"]);
  });

  it("always gives the workers a 16 MiB semi-space, whatever the daemon was started with (R45)", () => {
    for (const given of [
      [],
      ["--max-semi-space-size=1"],
      ["--max-semi-space-size", "1"],
      ["--max-semi-space-size=64", "--conditions=development"],
    ]) {
      const flags = workerExecArgv(given).filter((arg) => arg.includes("semi-space"));
      expect(flags).toEqual(["--max-semi-space-size=16"]);
    }
  });

  describe("PAP_TEST_WORKER_IMPORT (R130)", () => {
    const withScript = { PAP_TEST_PROVIDER_SCRIPT: "/s.json" };

    it("adds an absolute preload to the workers' node flags, after the daemon's own", () => {
      const config = loadConfig({
        ...base,
        piHostExecArgv: ["--conditions=development"],
        env: { ...withScript, PAP_TEST_WORKER_IMPORT: "/guards/network-guard.ts" },
      });
      expect(config.piHostExecArgv).toEqual([
        "--conditions=development",
        "--import=/guards/network-guard.ts",
      ]);
    });

    it("refuses a relative or bare specifier, with or without the scripted provider", () => {
      for (const value of ["./x.mjs", "x.mjs", "pkg/register", "file:///guard.ts", ""]) {
        for (const env of [{}, withScript]) {
          expect(() => loadConfig({ ...base, env: { ...env, PAP_TEST_WORKER_IMPORT: value } })).toThrow(
            "PAP_TEST_WORKER_IMPORT must be an absolute path",
          );
        }
      }
    });

    it("is ignored unless PAP_TEST_PROVIDER_SCRIPT is set too", () => {
      const config = loadConfig({
        ...base,
        piHostExecArgv: ["--conditions=development"],
        env: { PAP_TEST_WORKER_IMPORT: "/guards/network-guard.ts" },
      });
      expect(config.piHostExecArgv).toEqual(["--conditions=development"]);
    });
  });

  it("clamps the default worker cap between 2 and 16", () => {
    expect(defaultMaxWorkers(1024, 600)).toBe(2);
    expect(defaultMaxWorkers(1_000_000, 600)).toBe(16);
    expect(defaultMaxWorkers(12_000, 600)).toBe(10);
  });

  it("applies the worker budget of 285 MB by default (docs/spikes/s4-m2-long-session.md)", () => {
    expect(WORKER_BUDGET_MB).toBe(285);
    expect(defaultMaxWorkers(19_995)).toBe(16);
    expect(defaultMaxWorkers(16_384)).toBe(16);
    expect(defaultMaxWorkers(8_192)).toBe(14);
    expect(defaultMaxWorkers(4_096)).toBe(7);
    expect(defaultMaxWorkers(2_048)).toBe(3);
  });

  it("treats an empty PAP_HOME or PI_CODING_AGENT_DIR as unset", () => {
    const config = loadConfig({ ...base, env: { PAP_HOME: "", PI_CODING_AGENT_DIR: "" } });
    expect([config.home, config.piAgentDir]).toEqual(["/home/u/.pap", "/home/u/.pi/agent"]);
  });

  it("expands a leading ~ like Pi does and keeps absolute paths", () => {
    const tilde = loadConfig({ ...base, env: { PAP_HOME: "~/pap", PI_CODING_AGENT_DIR: "~/agent" } });
    expect([tilde.home, tilde.piAgentDir]).toEqual(["/home/u/pap", "/home/u/agent"]);
    expect(loadConfig({ ...base, env: { PAP_HOME: "~", PI_CODING_AGENT_DIR: "~" } }).home).toBe("/home/u");
    const absolute = loadConfig({ ...base, env: { PAP_HOME: "/srv/pap", PI_CODING_AGENT_DIR: "/srv/pi" } });
    expect([absolute.home, absolute.piAgentDir]).toEqual(["/srv/pap", "/srv/pi"]);
  });

  it("rejects a relative PAP_HOME or PI_CODING_AGENT_DIR", () => {
    for (const env of [
      { PAP_HOME: "data" },
      { PAP_HOME: "./data" },
      { PI_CODING_AGENT_DIR: "agent" },
      { PAP_HOME: "~other/x" },
    ]) {
      expect(() => loadConfig({ ...base, env })).toThrow(ConfigError);
    }
  });

  it("rejects an empty or malformed --host instead of binding every interface", () => {
    const bad = [
      ["--host", ""],
      ["--host="],
      ["--host", "   "],
      ["--host", "a/b"],
      ["--host", "evil.com:80"],
      ["--host", "a@b"],
      ["--host", "a b"],
    ];
    for (const argv of bad) expect(() => loadConfig({ ...base, argv })).toThrow(ConfigError);
  });

  it("lowercases the host, so LOCALHOST is loopback", () => {
    const config = loadConfig({ ...base, argv: ["--host", "LOCALHOST"] });
    expect([config.host, config.publicOrigin]).toEqual(["localhost", "http://localhost:7777"]);
    expect(loadConfig({ ...base, argv: ["--host", "Pap.Example.COM"] }).publicOrigin).toBe(
      "http://pap.example.com:7777",
    );
  });

  it("accepts bracketed and bare IPv6 hosts and brackets them in origins", () => {
    const loopback = loadConfig({ ...base, argv: ["--host", "[::1]"] });
    expect([loopback.host, loopback.publicOrigin]).toEqual(["::1", "http://localhost:7777"]);
    expect(loopback.allowedOrigins.has("http://[::1]:7777")).toBe(true);
    const global = loadConfig({ ...base, argv: ["--host", "2001:db8::1"] });
    expect([global.host, global.publicOrigin]).toEqual(["2001:db8::1", "http://[2001:db8::1]:7777"]);
    expect(global.allowedOrigins.has("http://localhost:7777")).toBe(false);
  });

  it("keeps an explicit wildcard host and publishes a localhost origin for it", () => {
    for (const host of ["0.0.0.0", "::"]) {
      const config = loadConfig({ ...base, argv: ["--host", host] });
      expect([config.host, config.publicOrigin]).toEqual([host, "http://localhost:7777"]);
    }
  });

  it("never echoes a rejected value in an error message", () => {
    const secret = "s3cr3t-value";
    const attempts: Partial<ConfigInput>[] = [
      { argv: ["--port", secret] },
      { argv: ["--host", `a/${secret}`] },
      { argv: [`--host=${secret}:80`] },
      { argv: [`--bogus=${secret}`] },
      { argv: [secret] },
      { env: { PAP_PUBLIC_ORIGIN: `https://owner:${secret}@` } },
      { env: { PAP_PUBLIC_ORIGIN: secret } },
      { env: { PAP_TEST_PROVIDER_SCRIPT: secret } },
      { env: { PAP_TEST_WORKER_IMPORT: secret } },
      { env: { PAP_MAX_WORKERS: secret } },
      { env: { PAP_MIN_FREE_MEM_MB: secret } },
      { env: { PAP_LOG_LEVEL: secret } },
      { env: { PAP_HOME: secret } },
      { env: { PI_CODING_AGENT_DIR: secret } },
    ];
    for (const attempt of attempts) {
      const failure = (() => {
        try {
          loadConfig({ ...base, ...attempt });
        } catch (error) {
          return error;
        }
        return null;
      })();
      expect(failure).toBeInstanceOf(ConfigError);
      expect((failure as ConfigError).message).not.toContain(secret);
    }
  });
});

describe("worker settings", () => {
  it("defaults to 30 idle minutes, automatic scopes, half the RAM (at least 2 GiB) and 4096 tasks", () => {
    const config = loadConfig(base);
    expect(config.workerIdleMs).toBe(30 * 60_000);
    expect(config.workerScope).toBe("auto");
    expect(config.workerLimits).toEqual({ memoryMaxMb: 8192, tasksMax: 4096 });
    expect(loadConfig({ ...base, totalMemMb: 2048 }).workerLimits.memoryMaxMb).toBe(2048);
  });

  it("reads them from the environment", () => {
    const config = loadConfig({
      ...base,
      env: {
        PAP_WORKER_IDLE_MINUTES: "0",
        PAP_WORKER_SCOPE: "off",
        PAP_WORKER_MEMORY_MAX_MB: "1024",
        PAP_WORKER_TASKS_MAX: "512",
      },
    });
    expect(config.workerIdleMs).toBe(0);
    expect(config.workerScope).toBe("off");
    expect(config.workerLimits).toEqual({ memoryMaxMb: 1024, tasksMax: 512 });
  });

  it.each([
    [{ PAP_WORKER_SCOPE: "maybe" }, "PAP_WORKER_SCOPE must be auto or off"],
    [{ PAP_WORKER_MEMORY_MAX_MB: "128" }, "PAP_WORKER_MEMORY_MAX_MB must be an integer ≥ 1024"],
    [{ PAP_WORKER_MEMORY_MAX_MB: "1023" }, "PAP_WORKER_MEMORY_MAX_MB must be an integer ≥ 1024"],
    [{ PAP_WORKER_TASKS_MAX: "8" }, "PAP_WORKER_TASKS_MAX must be an integer ≥ 64"],
    [{ PAP_WORKER_IDLE_MINUTES: "-1" }, "PAP_WORKER_IDLE_MINUTES must be an integer ≥ 0"],
    [{ PAP_WORKER_IDLE_MINUTES: "35792" }, "PAP_WORKER_IDLE_MINUTES must be an integer ≤ 35791"],
  ])("refuses %j", (env, message) => {
    expect(() => loadConfig({ ...base, env })).toThrow(message);
  });
});

describe("worker idle limit", () => {
  it("accepts the largest delay a timer can hold", () => {
    const config = loadConfig({ ...base, env: { PAP_WORKER_IDLE_MINUTES: "35791" } });
    expect(config.workerIdleMs).toBe(35_791 * 60_000);
    expect(config.workerIdleMs).toBeLessThan(2 ** 31);
  });
});
