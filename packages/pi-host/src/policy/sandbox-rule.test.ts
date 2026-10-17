import { PolicyRules } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import type { CallFacts } from "./pipeline.ts";
import { egressStage } from "./egress.ts";
import { sandboxVerdict, UNSANDBOXED_SHELL } from "./sandbox-rule.ts";
import { classifyTool, type ToolKind } from "./tool-kind.ts";

const caged = (mode: "auto-accept-edits" | "full-access" = "auto-accept-edits") =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: mode,
    agentHome: "/p/agents/atlas-1a2b",
    sandbox: { required: true, network: false },
  });

function callOf(
  toolName: string,
  kind: ToolKind,
  rules: PolicyRules,
  input: unknown = { command: "ls" },
): CallFacts {
  return {
    event: { toolCallId: "c1", toolName, input },
    kind,
    rules,
    cwd: "/p/agents/atlas-1a2b",
    tainted: false,
    key: "k",
    exec: kind.category === "exec" && kind.builtin,
  };
}
const piBash = classifyTool("bash", { path: "builtin:bash" });
const papBash: ToolKind = {
  category: "exec",
  external: false,
  urlBearing: true,
  mcp: false,
  builtin: false,
  sandboxed: true,
};
const extensionTool = classifyTool("run_it", { path: "/ext/run.js", readOnlyHint: true });

describe("the sandbox rule (M11R34)", () => {
  it("blocks Pi's bash when the sandbox is required", () => {
    expect(sandboxVerdict(callOf("bash", piBash, caged()))).toMatchObject({
      outcome: "block",
      reason: UNSANDBOXED_SHELL,
    });
  });

  it("blocks Pi's powershell", () => {
    const kind = classifyTool("powershell", { path: "builtin:powershell" });
    expect(sandboxVerdict(callOf("powershell", kind, caged()))?.outcome).toBe("block");
  });

  it("lets pap's own sandboxed bash through", () => {
    expect(sandboxVerdict(callOf("bash", papBash, caged()))).toBeNull();
  });

  it("blocks an extension tool whose input has a command string, whatever its category", () => {
    expect(extensionTool.category).not.toBe("exec");
    expect(sandboxVerdict(callOf("run_it", extensionTool, caged()))?.outcome).toBe("block");
  });

  it("blocks an extension's own bash that is not the sandboxed one, in full access too", () => {
    const own = classifyTool("bash", { path: "/ext/bash.js" });
    expect(sandboxVerdict(callOf("bash", own, caged("full-access")))?.outcome).toBe("block");
  });

  it("does not judge a tool without a command", () => {
    expect(sandboxVerdict(callOf("run_it", extensionTool, caged(), { query: "x" }))).toBeNull();
    expect(sandboxVerdict(callOf("run_it", extensionTool, caged(), { command: 5 }))).toBeNull();
  });

  it("does nothing when the sandbox is not required or the rules have none", () => {
    const optional = PolicyRules.parse({
      profile: "agent-thread",
      approvalMode: "auto-accept-edits",
      sandbox: { required: false, network: false },
    });
    const none = PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" });
    expect(sandboxVerdict(callOf("bash", piBash, optional))).toBeNull();
    expect(sandboxVerdict(callOf("bash", piBash, none))).toBeNull();
  });

  it("is part of stage 02, after the allowlist and the unattended block", () => {
    expect(egressStage(callOf("bash", piBash, caged()))).toMatchObject({
      outcome: "block",
      reason: UNSANDBOXED_SHELL,
    });
    expect(egressStage(callOf("bash", papBash, caged())).outcome).toBe("skip");
    const listed = PolicyRules.parse({ ...caged(), toolAllowlist: ["read"] });
    expect(egressStage(callOf("bash", piBash, listed))).toMatchObject({
      outcome: "block",
      reason: "tool not in the automation's allowlist",
    });
  });
});
