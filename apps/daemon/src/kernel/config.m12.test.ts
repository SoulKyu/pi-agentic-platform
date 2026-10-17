import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ConfigInput } from "./config.ts";

const input = (env: NodeJS.ProcessEnv): ConfigInput => ({
  argv: [],
  env,
  cwd: "/tmp",
  homedir: "/home/u",
  totalMemMb: 16_384,
  piHostEntry: "/x/main.js",
  piHostExecArgv: [],
  staticRoot: null,
});

const SCRIPT = { PAP_TEST_PROVIDER_SCRIPT: "/tmp/script.json" };

function refusal(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(input(env));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

describe("PAP_TEST_PUSH_LOOPBACK (M12R19)", () => {
  it("is off by default", () => {
    expect(loadConfig(input({})).testPushLoopback).toBe(false);
  });

  it("needs PAP_TEST_PROVIDER_SCRIPT", () => {
    expect(refusal({ PAP_TEST_PUSH_LOOPBACK: "1" }).message).toBe(
      "PAP_TEST_PUSH_LOOPBACK needs PAP_TEST_PROVIDER_SCRIPT",
    );
  });

  it("is on with the script", () => {
    expect(loadConfig(input({ ...SCRIPT, PAP_TEST_PUSH_LOOPBACK: "1" })).testPushLoopback).toBe(true);
  });

  it("accepts only 1", () => {
    expect(refusal({ ...SCRIPT, PAP_TEST_PUSH_LOOPBACK: "yes" }).message).toContain("PAP_TEST_PUSH_LOOPBACK");
  });
});

describe("PAP_PUSH_SUBJECT (M12R5)", () => {
  it("is null when unset or empty", () => {
    expect(loadConfig(input({})).pushSubject).toBeNull();
    expect(loadConfig(input({ PAP_PUSH_SUBJECT: "" })).pushSubject).toBeNull();
  });

  it("keeps an https URL or a mailto address", () => {
    expect(loadConfig(input({ PAP_PUSH_SUBJECT: "https://pap.example.net/contact" })).pushSubject).toBe(
      "https://pap.example.net/contact",
    );
    expect(loadConfig(input({ PAP_PUSH_SUBJECT: "mailto:ops@example.net" })).pushSubject).toBe(
      "mailto:ops@example.net",
    );
  });

  it.each([
    "http://pap.example.net",
    "ftp://pap.example.net",
    "pap.example.net",
    "mailto:a@b",
    "mailto:nope",
  ])("refuses %s without echoing it", (value) => {
    const error = refusal({ PAP_PUSH_SUBJECT: value });
    expect(error.message).toContain("PAP_PUSH_SUBJECT");
    expect(error.message).not.toContain(value);
  });
});

describe("PAP_PUSH_EXTRA_HOSTS (M12R8)", () => {
  it("is an empty list when unset or empty", () => {
    expect(loadConfig(input({})).pushExtraHosts).toEqual([]);
    expect(loadConfig(input({ PAP_PUSH_EXTRA_HOSTS: "" })).pushExtraHosts).toEqual([]);
  });

  it("keeps exact host names, trimmed and lowercased", () => {
    expect(
      loadConfig(input({ PAP_PUSH_EXTRA_HOSTS: " Push.Example.net ,relay.example.org" })).pushExtraHosts,
    ).toEqual(["push.example.net", "relay.example.org"]);
  });

  it("accepts eight hosts and refuses a ninth", () => {
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.net`).join(",");
    expect(loadConfig(input({ PAP_PUSH_EXTRA_HOSTS: hosts(8) })).pushExtraHosts).toHaveLength(8);
    expect(refusal({ PAP_PUSH_EXTRA_HOSTS: hosts(9) }).message).toContain("PAP_PUSH_EXTRA_HOSTS");
  });

  it.each([
    "192.0.2.1",
    "0x7f.1",
    "2130706433",
    "[::1]",
    "https://push.example.net",
    "push.example.net/path",
    "push.example.net:443",
    "user@push.example.net",
    "localhost",
    "a..example.net",
    ".example.net",
    "example.net.",
    "-a.example.net",
    "ok.example.net,",
    "ok.example.net,,x.example.net",
    "*.example.net",
    "ünï.example.net",
  ])("refuses %s without echoing it", (value) => {
    const error = refusal({ PAP_PUSH_EXTRA_HOSTS: value });
    expect(error.message).toContain("PAP_PUSH_EXTRA_HOSTS");
    expect(error.message).not.toContain(value);
  });
});
