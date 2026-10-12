import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUARD,
  DenyPattern,
  HostPattern,
  PolicyRules,
  PolicySettings,
  SessionPolicyView,
  StageVerdict,
  TaintState,
} from "./policy.ts";

const M2_RULES = { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: [] };

describe("PolicyRules v2", () => {
  it("reads M2 rules with every new field at its default", () => {
    expect(PolicyRules.parse(M2_RULES)).toEqual({
      ...M2_RULES,
      builtinDenylist: true,
      denylist: [],
      allowHosts: null,
      guard: DEFAULT_GUARD,
      taint: { tainted: false, epoch: 0 },
    });
  });

  it("accepts the four modes and nothing else", () => {
    for (const approvalMode of ["read-only", "supervised", "auto-accept-edits", "full-access"])
      expect(PolicyRules.safeParse({ ...M2_RULES, approvalMode }).success).toBe(true);
    for (const approvalMode of ["auto", "full", "", "FULL-ACCESS"])
      expect(PolicyRules.safeParse({ ...M2_RULES, approvalMode }).success).toBe(false);
  });

  it("refuses a key it does not know, so a restriction is never dropped silently (M5R1)", () => {
    expect(PolicyRules.safeParse({ ...M2_RULES, sandbox: "strict" }).success).toBe(false);
  });

  it("bounds every list and limit", () => {
    const ok = (field: string, value: unknown) =>
      PolicyRules.safeParse({ ...M2_RULES, [field]: value }).success;
    expect(
      ok(
        "denylist",
        Array.from({ length: 65 }, (_, i) => `rm ${i}`),
      ),
    ).toBe(false);
    expect(
      ok(
        "allowHosts",
        Array.from({ length: 257 }, (_, i) => `h${i}.example.com`),
      ),
    ).toBe(false);
    expect(ok("guard", { identicalCalls: 1, toolCalls: 150, turns: 60 })).toBe(false);
    expect(ok("guard", { identicalCalls: 5, toolCalls: 0, turns: 60 })).toBe(false);
    expect(ok("taint", { tainted: true, epoch: -1 })).toBe(false);
    expect(ok("taint", { tainted: true, epoch: 1.5 })).toBe(false);
  });
});

describe("patterns the owner writes", () => {
  it("takes a deny pattern of 1..256 printable characters", () => {
    expect(DenyPattern.safeParse("git push --force*").success).toBe(true);
    for (const bad of ["", "x".repeat(257), "rm\n-rf", "rm\u0000", "rm\u0085", "\u202Erm"])
      expect(DenyPattern.safeParse(bad).success).toBe(false);
  });

  it("takes a lower-case host or one wildcard label, never an IP, a port or a path", () => {
    for (const good of ["example.com", "*.example.com", "a-b.example.co.uk", "xn--bcher-kva.example"])
      expect(HostPattern.safeParse(good).success).toBe(true);
    for (const bad of [
      "Example.com",
      "*.com.*",
      "example.com:443",
      "example.com/x",
      "127.0.0.1",
      "[::1]",
      "*",
      "*.",
      "-a.example.com",
      "a..example.com",
      "localhost",
      `${"a".repeat(64)}.example.com`,
    ])
      expect(HostPattern.safeParse(bad).success).toBe(false);
  });
});

describe("taint, settings, views and verdicts", () => {
  it("bounds the taint epoch and keeps the flag a boolean", () => {
    expect(TaintState.parse({ tainted: true, epoch: 3 })).toEqual({ tainted: true, epoch: 3 });
    expect(TaintState.safeParse({ tainted: "yes", epoch: 0 }).success).toBe(false);
  });

  it("gives settings their defaults: auto-accept edits, the built-in denylist on, no egress list", () => {
    expect(PolicySettings.parse({})).toEqual({
      defaultMode: "auto-accept-edits",
      builtinDenylist: true,
      denylist: [],
      allowHosts: null,
    });
  });

  it("names a stage and an outcome from fixed lists, with a short reason", () => {
    expect(StageVerdict.safeParse({ stage: "03", outcome: "ask", reason: "exec" }).success).toBe(true);
    expect(StageVerdict.safeParse({ stage: "08", outcome: "pass" }).success).toBe(false);
    expect(StageVerdict.safeParse({ stage: "01", outcome: "maybe" }).success).toBe(false);
    expect(StageVerdict.safeParse({ stage: "01", outcome: "block", reason: "x".repeat(257) }).success).toBe(
      false,
    );
  });

  it("describes a session's policy for the header", () => {
    expect(SessionPolicyView.parse({ mode: "full-access", explicit: true, tainted: true })).toEqual({
      mode: "full-access",
      explicit: true,
      tainted: true,
    });
  });
});
