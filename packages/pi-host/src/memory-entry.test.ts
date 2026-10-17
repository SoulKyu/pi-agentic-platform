import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_LIMITS, AgentMemoryPolicy } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  appendMemoryTrust,
  appendMidRunUntrusted,
  MEM0_PROFILE_ENTRY,
  MEMORY_TRUST_ENTRY,
} from "./memory-entry.ts";

type Entries = ReadonlyArray<{ type: string; customType?: string; data?: unknown }>;

// A copy of the reader of pi-mem0 (`src/agent-session.ts`: `agentSessionFromEntries`, `readMemoryPolicy`,
// `parseMemoryPolicy`), so that a change of pap's entry that pi-mem0 would read differently fails here. Read-only
// mirror, never imported. `redactSecrets` on the hint is left out (it changes the text, not the validity).
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FAIL_CLOSED = { capture: "off", save: "staged" };
function parseMemoryPolicy(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const {
    capture = "auto",
    save = "direct",
    hint,
    recallLimit,
    recallThreshold,
  } = value as Record<string, unknown>;
  if (capture !== "auto" && capture !== "off") return undefined;
  if (save !== "direct" && save !== "staged") return undefined;
  if (hint !== undefined && (typeof hint !== "string" || hint.length > 500)) return undefined;
  if (
    recallLimit !== undefined &&
    (!Number.isInteger(recallLimit) || (recallLimit as number) < 0 || (recallLimit as number) > 20)
  )
    return undefined;
  if (
    recallThreshold !== undefined &&
    (typeof recallThreshold !== "number" || !(recallThreshold >= 0 && recallThreshold <= 1))
  )
    return undefined;
  return {
    capture,
    save,
    ...(hint ? { hint } : {}),
    ...(recallLimit !== undefined ? { recallLimit: recallLimit as number } : {}),
    ...(recallThreshold !== undefined ? { recallThreshold } : {}),
  };
}
function mem0Reads(entries: Entries) {
  let newest: { profile?: unknown; trust?: unknown; memory?: unknown } | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-web:agent-profile") continue;
    const data = entry.data as
      { version?: unknown; profile?: unknown; trust?: unknown; memory?: unknown } | undefined;
    if (data?.version === 1) newest = data;
  }
  if (!newest) return undefined;
  if (typeof newest.profile !== "string" || !PROFILE_NAME.test(newest.profile))
    return { profile: undefined, trust: "untrusted", invalid: true };
  const memory = newest.memory === undefined ? undefined : (parseMemoryPolicy(newest.memory) ?? FAIL_CLOSED);
  return {
    profile: newest.profile,
    trust: newest.trust === "trusted" ? "trusted" : "untrusted",
    ...(memory ? { memory } : {}),
  };
}

const profileEntries = (manager: SessionManager) =>
  manager.getEntries().filter((e) => e.type === "custom" && e.customType === MEM0_PROFILE_ENTRY);

describe("appendMemoryTrust (M11R142)", () => {
  it("appends one version-1 entry that pi-mem0 reads as trusted, with the policy", () => {
    const manager = SessionManager.inMemory();
    appendMemoryTrust(manager, {
      profile: "atlas-1a2b",
      trust: "trusted",
      memory: { capture: "auto", save: "staged" },
    });
    const entries = profileEntries(manager);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      data: {
        version: 1,
        profile: "atlas-1a2b",
        trust: "trusted",
        memory: { capture: "auto", save: "staged" },
      },
    });
    expect(mem0Reads(manager.getEntries())).toEqual({
      profile: "atlas-1a2b",
      trust: "trusted",
      memory: { capture: "auto", save: "staged" },
    });
  });

  it("a policy at every limit pap accepts is read intact by pi-mem0, never failed closed", () => {
    const policy = AgentMemoryPolicy.parse({
      capture: "off",
      save: "staged",
      hint: "h".repeat(AGENT_LIMITS.memoryHintChars),
      recallLimit: 20,
      recallThreshold: 1,
    });
    const manager = SessionManager.inMemory();
    appendMemoryTrust(manager, { profile: "atlas-1a2b", trust: "trusted", memory: policy });
    expect(mem0Reads(manager.getEntries())).toEqual({
      profile: "atlas-1a2b",
      trust: "trusted",
      memory: policy,
    });
  });

  it("a policy parsed from an empty block (the defaults pap adds) is read as the defaults", () => {
    const manager = SessionManager.inMemory();
    appendMemoryTrust(manager, {
      profile: "atlas-1a2b",
      trust: "trusted",
      memory: AgentMemoryPolicy.parse({}),
    });
    expect(mem0Reads(manager.getEntries())).toMatchObject({ memory: { capture: "auto", save: "direct" } });
  });

  it("an untrusted entry keeps its profile and reads as untrusted", () => {
    const manager = SessionManager.inMemory();
    appendMemoryTrust(manager, { profile: "atlas-1a2b", trust: "untrusted" });
    expect(profileEntries(manager)[0]?.type === "custom" && profileEntries(manager)[0]).toMatchObject({
      data: { version: 1, profile: "atlas-1a2b", trust: "untrusted" },
    });
    expect(mem0Reads(manager.getEntries())).toMatchObject({ profile: "atlas-1a2b", trust: "untrusted" });
  });

  it("the empty profile is the one pi-mem0 fails closed on (no valid profile)", () => {
    const manager = SessionManager.inMemory();
    appendMemoryTrust(manager, { profile: "", trust: "untrusted" });
    expect(mem0Reads(manager.getEntries())).toEqual({
      profile: undefined,
      trust: "untrusted",
      invalid: true,
    });
  });

  it("appends nothing for a reopen with the same trust, and a newer entry for a change", () => {
    const manager = SessionManager.inMemory();
    const trusted = { profile: "atlas-1a2b", trust: "trusted", memory: { capture: "auto" } } as const;
    appendMemoryTrust(manager, trusted);
    appendMemoryTrust(manager, trusted);
    expect(profileEntries(manager)).toHaveLength(1);
    appendMemoryTrust(manager, { profile: "atlas-1a2b", trust: "untrusted" });
    expect(profileEntries(manager)).toHaveLength(2);
    expect(mem0Reads(manager.getEntries())).toMatchObject({ trust: "untrusted" });
    appendMemoryTrust(manager, { profile: "atlas-1a2b", trust: "untrusted" });
    expect(profileEntries(manager)).toHaveLength(2);
  });
});

describe("appendMidRunUntrusted (M11R143)", () => {
  it("writes pap:memory-trust and leaves pi-mem0's own entry alone", () => {
    const manager = SessionManager.inMemory();
    appendMemoryTrust(manager, { profile: "atlas-1a2b", trust: "trusted" });
    appendMidRunUntrusted(manager);
    const entry = manager
      .getEntries()
      .find((e) => e.type === "custom" && e.customType === MEMORY_TRUST_ENTRY);
    expect(entry).toMatchObject({ data: { version: 1, trust: "untrusted" } });
    expect(profileEntries(manager)).toHaveLength(1);
  });
});
