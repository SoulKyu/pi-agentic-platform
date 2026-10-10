import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, defaultMaxWorkers, loadConfig, type ConfigInput } from "./config.ts";

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

  it("requires --tls-cert and --tls-key together and switches the origin to https", () => {
    expect(() => loadConfig({ ...base, argv: ["--tls-cert", "/c.pem"] })).toThrow(ConfigError);
    expect(loadConfig({ ...base, argv: ["--tls-cert", "/c.pem", "--tls-key", "/k.pem"] }).publicOrigin).toBe(
      "https://localhost:7777",
    );
  });

  it("rejects bad ports, relative test scripts and unknown flags", () => {
    expect(() => loadConfig({ ...base, argv: ["--port", "70000"] })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, env: { PAP_TEST_PROVIDER_SCRIPT: "script.json" } })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, argv: ["--bogus"] })).toThrow();
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

  it("clamps the default worker cap between 2 and 16", () => {
    expect(defaultMaxWorkers(1024, 600)).toBe(2);
    expect(defaultMaxWorkers(1_000_000, 600)).toBe(16);
    expect(defaultMaxWorkers(12_000, 600)).toBe(10);
  });

  it("applies the S4 worker budget by default (docs/spikes/s4.md)", () => {
    expect(defaultMaxWorkers(19_995)).toBe(16);
    expect(defaultMaxWorkers(4_096)).toBe(8);
    expect(defaultMaxWorkers(2_048)).toBe(4);
  });

  it("never echoes a rejected value in an error message", () => {
    const secret = "s3cr3t-value";
    const attempts: Partial<ConfigInput>[] = [
      { argv: ["--port", secret] },
      { argv: [`--bogus=${secret}`] },
      { argv: [secret] },
      { env: { PAP_PUBLIC_ORIGIN: `https://owner:${secret}@` } },
      { env: { PAP_PUBLIC_ORIGIN: secret } },
      { env: { PAP_TEST_PROVIDER_SCRIPT: secret } },
      { env: { PAP_MAX_WORKERS: secret } },
      { env: { PAP_MIN_FREE_MEM_MB: secret } },
      { env: { PAP_LOG_LEVEL: secret } },
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
