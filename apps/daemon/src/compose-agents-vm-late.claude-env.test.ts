import { describe, expect, it, vi } from "vitest";
import { CLAUDE_BRIDGE_PROVIDER, createClaudeEnvOf } from "./compose-agents-vm-late.ts";

const logger = { warn: vi.fn() };
const make = (sources: string[] | null | Error, daemonEnv: Record<string, string> = {}) =>
  createClaudeEnvOf({
    sourcesOf: () => (sources instanceof Error ? Promise.reject(sources) : Promise.resolve(sources)),
    logger,
    daemonEnv,
  });
const plain = { model: { provider: "anthropic" }, packages: ["a"] };
const bridgeModel = { model: { provider: CLAUDE_BRIDGE_PROVIDER }, packages: [] };
const bridgePackage = { model: null, packages: ["a"] };

describe("createClaudeEnvOf", () => {
  it("gives a VM bridge agent IS_SANDBOX and a CLAUDE_CONFIG_DIR in its home, by model or by package", async () => {
    const want = { IS_SANDBOX: "1", CLAUDE_CONFIG_DIR: "/agent/home/.claude" };
    const vm = { vm: true, home: "/agent/home" };
    expect(await make([])(bridgeModel, vm)).toEqual(want);
    expect(await make(["npm:pi-claude-bridge@1.2.3"])(bridgePackage, vm)).toEqual(want);
  });

  it("gives a host bridge agent only CLAUDE_CONFIG_DIR in its home", async () => {
    const host = { vm: false, home: "/pap/agents/abc" };
    expect(await make([])(bridgeModel, host)).toEqual({ CLAUDE_CONFIG_DIR: "/pap/agents/abc/.claude" });
    expect(await make(["git:x/pi-claude-bridge"])(bridgePackage, host)).toEqual({
      CLAUDE_CONFIG_DIR: "/pap/agents/abc/.claude",
    });
  });

  it("gives any other agent nothing, a fork of the bridge included", async () => {
    for (const where of [
      { vm: true, home: "/agent/home" },
      { vm: false, home: "/pap/agents/abc" },
    ]) {
      expect(await make(["npm:other"])(plain, where)).toEqual({});
      expect(await make(["npm:pi-claude-bridge-fork"])(plain, where)).toEqual({});
      expect(await make(null)({ model: null, packages: null }, where)).toEqual({});
    }
  });

  it("keeps the host's CLAUDE_CONFIG_DIR of the daemon, and still sets the VM's", async () => {
    const daemonEnv = { CLAUDE_CONFIG_DIR: "/srv/claude" };
    expect(await make([], daemonEnv)(bridgeModel, { vm: false, home: "/pap/agents/abc" })).toEqual({});
    expect(await make([], daemonEnv)(bridgeModel, { vm: true, home: "/agent/home" })).toEqual({
      IS_SANDBOX: "1",
      CLAUDE_CONFIG_DIR: "/agent/home/.claude",
    });
  });

  it("gives nothing, and logs, when the packages cannot be read", async () => {
    expect(await make(new Error("busy"))(bridgePackage, { vm: true, home: "/agent/home" })).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith("claude_env_packages_unread", expect.anything());
  });
});
