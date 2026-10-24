import { describe, expect, it } from "vitest";
import { MAX_DENY_PATTERNS, PolicyRules } from "./index.ts";

const base = { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: [] };

describe("PolicyRules agent fields (M11R7)", () => {
  it("defaults the three new fields to null", () => {
    const rules = PolicyRules.parse(base);
    expect(rules.agentHome).toBeNull();
    expect(rules.agentScratch).toBeNull();
    expect(rules.sandbox).toBeNull();
  });

  it("accepts the two agent profiles and the new fields", () => {
    const thread = PolicyRules.parse({
      ...base,
      profile: "agent-thread",
      agentHome: "/p/agents/atlas-1a2b",
      sandbox: { required: true, network: false },
    });
    expect(thread.profile).toBe("agent-thread");
    const task = PolicyRules.parse({
      ...base,
      profile: "isolated-task",
      agentHome: "/p/agents/atlas-1a2b",
      agentScratch: "/p/agents/.runs/atlas-1a2b/t1",
      sandbox: { required: true, network: true },
    });
    expect(task.agentScratch).toBe("/p/agents/.runs/atlas-1a2b/t1");
  });

  it("accepts the project profile of a session in a project's box", () => {
    const rules = PolicyRules.parse({
      ...base,
      profile: "project",
      agentHome: "/boxes/6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11/project",
      sandbox: { required: true, network: true },
    });
    expect(rules.profile).toBe("project");
  });

  it("refuses an unknown profile, relative or NUL folders and a sandbox without network", () => {
    expect(PolicyRules.safeParse({ ...base, profile: "root" }).success).toBe(false);
    expect(PolicyRules.safeParse({ ...base, agentHome: "agents/x" }).success).toBe(false);
    expect(PolicyRules.safeParse({ ...base, agentScratch: "scratch" }).success).toBe(false);
    expect(PolicyRules.safeParse({ ...base, agentHome: "/a\u0000b" }).success).toBe(false);
    expect(PolicyRules.safeParse({ ...base, sandbox: { required: true } }).success).toBe(false);
    expect(
      PolicyRules.safeParse({ ...base, sandbox: { required: true, network: false, extra: 1 } }).success,
    ).toBe(false);
  });

  it("allows 128 blocked commands in the rules, and the owner's settings keep 64", () => {
    const patterns = (count: number) => Array.from({ length: count }, (_, i) => `cmd${i}*`);
    expect(MAX_DENY_PATTERNS).toBe(64);
    expect(PolicyRules.safeParse({ ...base, denylist: patterns(128) }).success).toBe(true);
    expect(PolicyRules.safeParse({ ...base, denylist: patterns(129) }).success).toBe(false);
  });
});
