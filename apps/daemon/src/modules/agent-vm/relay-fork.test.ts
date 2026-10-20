import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { forkRelay, relayEnv, relayListenOf } from "./relay-fork.ts";
import { createStderrRedactor } from "./stderr-redactor.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-wildcard: `relayListenOf` answers a wildcard address -> "listens on the bridge address or loopback, never a wildcard" fails.
 *  - M-whole-env: `relayEnv` passes the whole environment -> "holds PI_CODING_AGENT_DIR and the allowlist only" fails.
 *  - M-tls-env: NODE_TLS_REJECT_UNAUTHORIZED is kept -> the same case fails.
 * T15b mutants, run for real:
 *  - M-no-redact: the line is logged as it came -> "logs a stderr line masked" fails.
 *  - M-clip-first: the line is clipped before it is masked -> "masks before it clips" fails.
 *  - M-per-line: the collector is asked for every line -> "logs a stderr line masked" (calls) fails.
 *  - M-partial-tail: a long line without newline keeps only its tail -> "masks before it clips" fails.
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

describe("the relay's stderr in the daemon's log (AVM-E40 M8)", () => {
  const VAULT_VALUE = `vault-value-${"E".repeat(10)}`;
  const KEY = `sk-${"a".repeat(30)}`;
  const dirs: string[] = [];
  const children: Array<{ pid?: number | undefined; kill(): boolean }> = [];
  afterEach(() => {
    for (const child of children.splice(0)) if ((child.pid ?? 0) > 1) child.kill();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Forks a child that writes `lines` to stderr, and answers what the daemon logged once `expected` lines are in. */
  async function logged(lines: string[], expected: number, calls: { n: number }): Promise<string[]> {
    return loggedScript(
      `for (const l of ${JSON.stringify(lines)}) process.stderr.write(l + "\\n");\n`,
      expected,
      calls,
    );
  }

  /** Same, for a child whose code is given. */
  async function loggedScript(code: string, expected: number, calls: { n: number }): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "pap-t15b-relay-"));
    dirs.push(dir);
    const entry = join(dir, "child.mjs");
    writeFileSync(entry, code);
    const out: string[] = [];
    const clock = createFakeClock();
    const done = new Promise<void>((resolve) => {
      const logger = {
        warn: (_msg: string, fields?: Record<string, unknown>) => {
          out.push(String(fields?.line));
          if (out.length >= expected) resolve();
        },
        debug: () => {},
        info: () => {},
        error: () => {},
        child: () => logger,
      } as unknown as Logger;
      const child = forkRelay({
        entry,
        execArgv: [],
        listen: "127.0.0.1:0",
        env: {},
        clock,
        logger,
        redact: createStderrRedactor({
          clock,
          collect: async () => (calls.n++, { secrets: [VAULT_VALUE] }),
        }),
      });
      children.push(child);
    });
    await done;
    return out;
  }

  it("logs a stderr line masked: the owner's value and an sk- key, the collector asked once", async () => {
    const calls = { n: 0 };
    const out = await logged([`bad ${VAULT_VALUE}`, `header ${KEY}`, "plain line"], 3, calls);
    expect(out.join("\n")).not.toContain(VAULT_VALUE);
    expect(out.join("\n")).not.toContain(KEY);
    expect(out[2]).toBe("plain line");
    expect(calls.n).toBe(1);
  });

  it("masks before it clips: a value that straddles the clip leaves no fragment", async () => {
    const calls = { n: 0 };
    const line = `${"x".repeat(290)}${VAULT_VALUE}`;
    const [out] = await logged([line], 1, calls);
    expect(out).not.toContain("vault-v");
    expect(out?.length).toBeLessThanOrEqual(300);
  });
});
