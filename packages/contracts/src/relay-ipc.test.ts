import { describe, expect, it } from "vitest";
import { RELAY_USAGE_MAX_AGENTS, RelayCommand, RelayReport } from "./relay-ipc.ts";

const grant = {
  type: "relay_grant",
  launchId: "a".repeat(32),
  agentId: "helper-1a2b",
  key: "b".repeat(64),
  address: "10.213.0.7",
};
const policy = {
  type: "agent_policy",
  agentId: "helper-1a2b",
  models: [{ provider: "anthropic", id: "claude-x" }],
  claude: false,
  blocked: null,
};

describe("RelayCommand", () => {
  it("accepts a grant for a bridge address and for loopback (the process backend)", () => {
    expect(RelayCommand.safeParse(grant).success).toBe(true);
    expect(RelayCommand.safeParse({ ...grant, address: "127.0.0.1" }).success).toBe(true);
  });

  it("refuses a grant for another address or with an upper-case key", () => {
    const patches = [
      { address: "192.168.1.5" },
      { address: "10.214.0.7" },
      { address: "10.213.0.1" },
      { address: "10.213.0.999" },
      { address: "10.213.0.255" },
      { key: "B".repeat(64) },
    ];
    for (const patch of patches) {
      expect(RelayCommand.safeParse({ ...grant, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("refuses a provider name with an upper-case letter and an empty Claude token", () => {
    const models = [{ provider: "Anthropic", id: "m" }];
    expect(RelayCommand.safeParse({ ...policy, models }).success).toBe(false);
    expect(RelayCommand.safeParse(policy).success).toBe(true);
    expect(RelayCommand.safeParse({ type: "claude_token", token: "" }).success).toBe(false);
    expect(RelayCommand.safeParse({ type: "claude_token", token: null }).success).toBe(true);
    expect(RelayCommand.safeParse({ type: "claude_token", token: "abc\r\nX-Evil: 1" }).success).toBe(false);
    expect(RelayCommand.safeParse({ type: "claude_token", token: "   " }).success).toBe(false);
  });

  it("bounds the model list and the blocked reasons", () => {
    const models = Array.from({ length: 513 }, (_, index) => ({ provider: "p", id: `m${index}` }));
    expect(RelayCommand.safeParse({ ...policy, models }).success).toBe(false);
    expect(RelayCommand.safeParse({ ...policy, blocked: "other" }).success).toBe(false);
    expect(RelayCommand.safeParse({ type: "relay_revoke", launchId: "a".repeat(32) }).success).toBe(true);
  });
});

describe("RelayReport", () => {
  it("parses a usage report and the ready report", () => {
    const usage = {
      type: "relay_usage",
      agents: [{ agentId: "helper-1a2b", requests: 3, refused: 1, bytesIn: 10, bytesOut: 20 }],
    };
    expect(RelayReport.safeParse(usage).success).toBe(true);
    expect(RelayReport.safeParse({ type: "relay_ready", port: 7842 }).success).toBe(true);
    const agents = (count: number) => Array.from({ length: count }, () => usage.agents[0]);
    expect(RelayReport.safeParse({ ...usage, agents: agents(RELAY_USAGE_MAX_AGENTS) }).success).toBe(true);
    expect(RelayReport.safeParse({ ...usage, agents: agents(RELAY_USAGE_MAX_AGENTS + 1) }).success).toBe(
      false,
    );
    expect(RelayReport.safeParse({ type: "relay_ready", port: 0 }).success).toBe(false);
  });
});
