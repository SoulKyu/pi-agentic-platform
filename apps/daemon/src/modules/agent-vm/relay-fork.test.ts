import { describe, expect, it } from "vitest";
import { relayEnv, relayListenOf } from "./relay-fork.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-wildcard: `relayListenOf` answers a wildcard address -> "listens on the bridge address or loopback, never a wildcard" fails.
 *  - M-whole-env: `relayEnv` passes the whole environment -> "holds PI_CODING_AGENT_DIR and the allowlist only" fails.
 *  - M-tls-env: NODE_TLS_REJECT_UNAUTHORIZED is kept -> the same case fails.
 */
describe("where pap-relay listens (AVM-P10)", () => {
  it("listens on the bridge address or loopback, never a wildcard (M-wildcard)", () => {
    expect(relayListenOf(false)).toBe("10.213.0.1:7842");
    expect(relayListenOf(true)).toBe("127.0.0.1:0");
    for (const loopback of [true, false])
      expect(relayListenOf(loopback)).not.toMatch(/^(0\.0\.0\.0|::|\[::\])/);
  });
});

describe("pap-relay's environment (AVM-P10, T12)", () => {
  const base = {
    PATH: "/usr/bin:relative/bin",
    HOME: "/home/owner",
    LANG: "C.UTF-8",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_OPTIONS: "--require /evil.js",
    ANTHROPIC_API_KEY: "sk-secret",
    OPENAI_API_KEY: "sk-secret-2",
    GH_TOKEN: "ghp_x",
    SSH_AUTH_SOCK: "/tmp/agent",
    PAP_METRICS_TOKEN: "m".repeat(40),
    HTTPS_PROXY: "http://proxy:3128",
    NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
    LD_PRELOAD: "/x.so",
  };

  it("holds PI_CODING_AGENT_DIR and the allowlist only (M-whole-env, M-tls-env)", () => {
    const env = relayEnv(base, "/pi/agent", null);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/owner",
      LANG: "C.UTF-8",
      TERM: "dumb",
      HTTPS_PROXY: "http://proxy:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      PI_CODING_AGENT_DIR: "/pi/agent",
    });
    expect(env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it("adds the scripted-provider switch only when a test script is named", () => {
    expect(relayEnv(base, "/pi/agent", "/script.json").PAP_TEST_PROVIDER_SCRIPT).toBe("/script.json");
    expect(relayEnv(base, "/pi/agent", null)).not.toHaveProperty("PAP_TEST_PROVIDER_SCRIPT");
  });
});
