import { describe, expect, it } from "vitest";
import { RELAY_USAGE_MAX_BOXES, RelayCommand, RelayReport } from "./relay-ipc.ts";

const AGENT_BOX = { kind: "agent", id: "helper-1a2b" } as const;
const PROJECT_BOX = { kind: "project", id: "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11" } as const;
const grant = {
  type: "relay_grant",
  launchId: "a".repeat(32),
  box: AGENT_BOX,
  key: "b".repeat(64),
  address: "10.213.0.7",
};
const policy = {
  type: "box_policy",
  box: AGENT_BOX,
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

describe("box identity", () => {
  it("carries an agent or a project box in the grant, the policy and the usage", () => {
    for (const box of [AGENT_BOX, PROJECT_BOX]) {
      expect(RelayCommand.safeParse({ ...grant, box }).success).toBe(true);
      expect(RelayCommand.safeParse({ ...policy, box }).success).toBe(true);
      const row = { box, requests: 1, refused: 0, bytesIn: 0, bytesOut: 0 };
      expect(RelayReport.safeParse({ type: "relay_usage", boxes: [row] }).success).toBe(true);
    }
    expect(RelayCommand.safeParse({ ...grant, box: undefined, agentId: "helper-1a2b" }).success).toBe(false);
    expect(RelayCommand.safeParse({ ...policy, type: "agent_policy" }).success).toBe(false);
  });
});

describe("RelayReport", () => {
  it("parses a usage report and the ready report", () => {
    const usage = {
      type: "relay_usage",
      boxes: [{ box: AGENT_BOX, requests: 3, refused: 1, bytesIn: 10, bytesOut: 20 }],
    };
    expect(RelayReport.safeParse(usage).success).toBe(true);
    expect(RelayReport.safeParse({ type: "relay_ready", port: 7842 }).success).toBe(true);
    const boxes = (count: number) => Array.from({ length: count }, () => usage.boxes[0]);
    expect(RelayReport.safeParse({ ...usage, boxes: boxes(RELAY_USAGE_MAX_BOXES) }).success).toBe(true);
    expect(RelayReport.safeParse({ ...usage, boxes: boxes(RELAY_USAGE_MAX_BOXES + 1) }).success).toBe(false);
    expect(RelayReport.safeParse({ type: "relay_ready", port: 0 }).success).toBe(false);
  });
});
