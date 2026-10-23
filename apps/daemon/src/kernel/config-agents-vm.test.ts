import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ConfigInput } from "./config.ts";
import { VM_OVERHEAD_MB } from "./config-agents-vm.ts";

const input = (env: NodeJS.ProcessEnv, totalMemMb = 16_384): ConfigInput => ({
  argv: [],
  env,
  cwd: "/tmp",
  homedir: "/home/u",
  totalMemMb,
  piHostEntry: "/x/main.js",
  piHostExecArgv: [],
  staticRoot: null,
});

const SCRIPT = { PAP_TEST_PROVIDER_SCRIPT: "/tmp/script.json" };

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(input(env));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("expected a ConfigError");
}

describe("PAP_AGENTS_RUNTIME", () => {
  it("reads no runtime from PAP_AGENTS_RUNTIME and flags that it is set", () => {
    const set = loadConfig(input({ PAP_AGENTS_RUNTIME: "host" }));
    expect(set.agentsRuntimeSet).toBe(true);
    expect(set).not.toHaveProperty("agentsRuntime");
    expect(loadConfig(input({ PAP_AGENTS_RUNTIME: "kata-secret" })).agentsRuntimeSet).toBe(true);
    expect(loadConfig(input({})).agentsRuntimeSet).toBe(false);
  });
});

describe("PAP_AGENTS_MEMORY_MAX_MB", () => {
  it("defaults to half of the memory", () => {
    expect(loadConfig(input({}, 16_384)).agentsMemoryMaxMb).toBe(8192);
    expect(loadConfig(input({}, 16_385)).agentsMemoryMaxMb).toBe(8192);
  });
  it("defaults to at least 1024 on a small host", () => {
    expect(loadConfig(input({}, 1500)).agentsMemoryMaxMb).toBe(1024);
  });
  it("takes an explicit value of at least 1024", () => {
    expect(loadConfig(input({ PAP_AGENTS_MEMORY_MAX_MB: "1024" })).agentsMemoryMaxMb).toBe(1024);
    expect(loadConfig(input({ PAP_AGENTS_MEMORY_MAX_MB: "12000" })).agentsMemoryMaxMb).toBe(12_000);
  });
  it("stops the boot below 1024 or on a non-integer", () => {
    expect(refusal({ PAP_AGENTS_MEMORY_MAX_MB: "1023" })).toBe(
      "PAP_AGENTS_MEMORY_MAX_MB must be an integer ≥ 1024",
    );
    expect(refusal({ PAP_AGENTS_MEMORY_MAX_MB: "abc" })).toContain("PAP_AGENTS_MEMORY_MAX_MB");
    expect(refusal({ PAP_AGENTS_MEMORY_MAX_MB: "1.5" })).toContain("PAP_AGENTS_MEMORY_MAX_MB");
  });
});

describe("PAP_TEST_AGENT_RUNTIME", () => {
  it("is off by default", () => {
    expect(loadConfig(input({})).testAgentRuntime).toBeNull();
  });
  it("needs PAP_TEST_PROVIDER_SCRIPT", () => {
    expect(refusal({ PAP_TEST_AGENT_RUNTIME: "process" })).toBe(
      "PAP_TEST_AGENT_RUNTIME needs PAP_TEST_PROVIDER_SCRIPT",
    );
  });
  it("is process with the script", () => {
    expect(loadConfig(input({ ...SCRIPT, PAP_TEST_AGENT_RUNTIME: "process" })).testAgentRuntime).toBe(
      "process",
    );
  });
  it("accepts only process", () => {
    expect(refusal({ ...SCRIPT, PAP_TEST_AGENT_RUNTIME: "kata" })).toBe(
      "PAP_TEST_AGENT_RUNTIME must be process",
    );
  });
});

it("VM_OVERHEAD_MB is 512 until T20a measures it (R29)", () => {
  expect(VM_OVERHEAD_MB).toBe(512);
});
