import { describe, expect, it } from "vitest";
import {
  AUDIT_ARGS_MAX,
  DEFAULT_GUARD,
  DenyPattern,
  HostPattern,
  PolicyAuditEntry,
  PolicyRules,
  PolicySettings,
  READ_ONLY_COMMAND_NAMES,
  SessionPolicyView,
  StageVerdict,
  TaintState,
} from "./policy.ts";

const M2_RULES = { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: [] };

describe("PolicyRules v2", () => {
  it("reads M2 rules with every new field at its default", () => {
    expect(PolicyRules.parse(M2_RULES)).toEqual({
      ...M2_RULES,
      alwaysPrefixes: [],
      alwaysTools: [],
      builtinDenylist: true,
      denylist: [],
      allowHosts: null,
      guard: DEFAULT_GUARD,
      taint: { tainted: false, epoch: 0 },
      readOnlyCommands: true,
      readOnlyPreset: false,
      presetTools: null,
      toolAllowlist: null,
      unattended: false,
    });
  });

  it("bounds the tool allowlist and types the unattended flag (M10R26, M10R152)", () => {
    const names = (count: number) => Array.from({ length: count }, (_, i) => `tool_${i}`);
    expect(PolicyRules.safeParse({ ...M2_RULES, toolAllowlist: names(32) }).success).toBe(true);
    expect(PolicyRules.safeParse({ ...M2_RULES, toolAllowlist: names(33) }).success).toBe(false);
    expect(PolicyRules.safeParse({ ...M2_RULES, toolAllowlist: ["-x"] }).success).toBe(false);
    expect(PolicyRules.safeParse({ ...M2_RULES, unattended: "yes" }).success).toBe(false);
    expect(PolicyRules.parse({ ...M2_RULES, unattended: true }).unattended).toBe(true);
  });

  it("runs read-only commands by default and refuses a non-boolean switch", () => {
    expect(
      PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" }).readOnlyCommands,
    ).toBe(true);
    expect(PolicyRules.safeParse({ ...M2_RULES, readOnlyCommands: "yes" }).success).toBe(false);
    expect(PolicyRules.parse({ ...M2_RULES, readOnlyCommands: false }).readOnlyCommands).toBe(false);
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
      readOnlyCommands: true,
    });
    expect(PolicySettings.parse({}).readOnlyCommands).toBe(true);
    expect(PolicySettings.safeParse({ readOnlyCommands: 1 }).success).toBe(false);
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
    expect(
      SessionPolicyView.parse({
        mode: "full-access",
        explicit: true,
        tainted: true,
        defaultMode: "supervised",
      }),
    ).toEqual({ mode: "full-access", explicit: true, tainted: true, defaultMode: "supervised" });
  });

  it("reads an older view without defaultMode as the auto-accept-edits default", () => {
    expect(SessionPolicyView.parse({ mode: "read-only", explicit: true, tainted: false }).defaultMode).toBe(
      "auto-accept-edits",
    );
    expect(
      SessionPolicyView.safeParse({ mode: "read-only", explicit: true, tainted: false, defaultMode: "x" })
        .success,
    ).toBe(false);
  });

  it("names every read-only command the table runs, for display (M7R125)", () => {
    expect(READ_ONLY_COMMAND_NAMES).toContain("cat");
    expect(READ_ONLY_COMMAND_NAMES).toContain("git status");
    expect(new Set(READ_ONLY_COMMAND_NAMES).size).toBe(READ_ONLY_COMMAND_NAMES.length);
  });
});

describe("PolicyAuditEntry", () => {
  const verdict = { stage: "03", outcome: "allow" } as const;
  const call = {
    kind: "call",
    toolCallId: "c1",
    tool: "read",
    category: "read",
    decision: "allow",
    stages: [verdict],
    args: "{}",
  } as const;

  it("accepts a call, a result and a session entry", () => {
    expect(PolicyAuditEntry.safeParse(call).success).toBe(true);
    expect(
      PolicyAuditEntry.safeParse({
        kind: "result",
        toolCallId: "c1",
        tool: "read",
        stages: [{ stage: "07", outcome: "acted" }],
        redactions: 0,
        external: true,
      }).success,
    ).toBe(true);
    expect(
      PolicyAuditEntry.safeParse({
        kind: "session",
        stages: [],
        tools: ["read"],
        toolsTruncated: false,
        mode: "supervised",
      }).success,
    ).toBe(true);
  });

  it("bounds a call entry: verdicts, arguments and names", () => {
    expect(PolicyAuditEntry.safeParse({ ...call, stages: Array(9).fill(verdict) }).success).toBe(false);
    expect(PolicyAuditEntry.safeParse({ ...call, stages: Array(8).fill(verdict) }).success).toBe(true);
    expect(AUDIT_ARGS_MAX).toBe(2048);
    expect(PolicyAuditEntry.safeParse({ ...call, args: "a".repeat(4112) }).success).toBe(true);
    expect(PolicyAuditEntry.safeParse({ ...call, args: "a".repeat(4113) }).success).toBe(false);
    expect(PolicyAuditEntry.safeParse({ ...call, tool: "t".repeat(257) }).success).toBe(false);
  });

  it("bounds the tool list of a session entry", () => {
    const session = { kind: "session", stages: [], toolsTruncated: false, mode: "supervised" };
    expect(PolicyAuditEntry.safeParse({ ...session, tools: Array(256).fill("t") }).success).toBe(true);
    expect(PolicyAuditEntry.safeParse({ ...session, tools: Array(257).fill("t") }).success).toBe(false);
  });

  it("needs redactions and external on a result entry", () => {
    const result = { kind: "result", toolCallId: "c1", tool: "read", stages: [] };
    expect(PolicyAuditEntry.safeParse({ ...result, external: false }).success).toBe(false);
    expect(PolicyAuditEntry.safeParse({ ...result, redactions: 1 }).success).toBe(false);
    expect(PolicyAuditEntry.safeParse({ ...result, redactions: 1, external: false }).success).toBe(true);
  });
});
