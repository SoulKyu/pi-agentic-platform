import { describe, expect, it } from "vitest";
import { AGENT_PROMPT_LIMITS, AgentPromptName, PermissionsView, QuarantineResult } from "./agents-safety.ts";
import { agentsMethods } from "./agents-methods.ts";

describe("Task 21 contracts", () => {
  it("accepts only one .md file name for a prompt chip", () => {
    for (const name of ["daily.md", "A-b_c.1.md", "x".repeat(61) + ".md"])
      expect(AgentPromptName.safeParse(name).success).toBe(true);
    for (const name of [
      "",
      "x",
      "x.txt",
      "../x.md",
      "a/b.md",
      ".md",
      ".hidden.md",
      "a b.md",
      "x".repeat(62) + ".md",
      "a\u0000.md",
    ])
      expect(AgentPromptName.safeParse(name).success).toBe(false);
    expect(AGENT_PROMPT_LIMITS).toEqual({ names: 12, nameChars: 64, bytes: 16384 });
  });

  it("answers a quarantine with secrets, names, a count and typed step errors", () => {
    const answer = {
      secrets: [{ triggerId: "t", name: "Hook", secret: "pwh_x" }],
      vaultNames: ["API_TOKEN"],
      tasksCancelled: 2,
      errors: [{ step: "thread", code: "failed" }],
    };
    expect(QuarantineResult.parse(answer)).toEqual(answer);
    expect(QuarantineResult.safeParse({ ...answer, errors: [{ step: "memory", code: "x" }] }).success).toBe(
      false,
    );
    expect(QuarantineResult.safeParse({ ...answer, vaultNames: ["lower"] }).success).toBe(false);
    expect(QuarantineResult.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });

  it("shapes the permissions sheet with the three autonomy fields and no folder list", () => {
    const sheet = {
      tools: { preset: "default", active: "unknown-until-start" },
      sandbox: { required: true, effective: "on", network: false },
      hosts: "owner's list",
      blocked: 3,
      vaultNames: [],
      triggers: [{ name: "Nightly", source: "schedule", target: "isolated" }],
      mcp: "owner's servers",
      trustedSources: ["docs.example.com"],
      trustedAutonomy: false,
      egress: "off",
      trifecta: { privateData: false, untrustedContent: true, exfiltration: false },
    };
    expect(PermissionsView.parse(sheet)).toEqual(sheet);
    expect(PermissionsView.safeParse({ ...sheet, folders: ["/home"] }).success).toBe(false);
    expect(PermissionsView.safeParse({ ...sheet, egress: "direct" }).success).toBe(false);
    expect(PermissionsView.safeParse({ ...sheet, hosts: "everything" }).success).toBe(false);
    expect(
      PermissionsView.safeParse({ ...sheet, tools: { preset: "default", active: ["read"] } }).success,
    ).toBe(true);
  });

  it("declares the four methods with the permissions the plan names", () => {
    const pick = (name: keyof typeof agentsMethods) => {
      const def = agentsMethods[name];
      return [def.permission, def.idempotent, "secretResult" in def];
    };
    expect(pick("agents.quarantine")).toEqual(["agents:admin", false, true]);
    expect(pick("agents.permissions")).toEqual(["agents:admin", true, false]);
    expect(pick("agents.prompts")).toEqual(["agents:read", true, false]);
    expect(pick("agents.prompt")).toEqual(["agents:read", true, false]);
    expect(agentsMethods["agents.setPaused"].errors).toContain("step_up_required");
    expect(agentsMethods["agents.prompt"].errors).toEqual(
      expect.arrayContaining(["payload_too_large", "bad_request", "invalid_cwd", "not_found"]),
    );
  });

  it("holds a secret for every trigger an owner can have, and no more (m1)", () => {
    const entry = { triggerId: "t", name: "Hook", secret: "pwh_x" };
    const answer = { secrets: [], vaultNames: [], tasksCancelled: 0, errors: [] };
    expect(QuarantineResult.safeParse({ ...answer, secrets: new Array(200).fill(entry) }).success).toBe(true);
    expect(QuarantineResult.safeParse({ ...answer, secrets: new Array(201).fill(entry) }).success).toBe(
      false,
    );
  });

  it("lets a caller handle forbidden on the permissions sheet (m3)", () => {
    expect(agentsMethods["agents.permissions"].errors).toEqual(
      expect.arrayContaining(["not_found", "forbidden"]),
    );
  });
});
