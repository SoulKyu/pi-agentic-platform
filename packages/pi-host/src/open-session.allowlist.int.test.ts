import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type InitRecord, PolicyRules, type PolicyAuditEntry } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovals } from "./approvals.ts";
import { openSession } from "./open-session.ts";
import { NOT_ALLOWLISTED, NOT_ALLOWLISTED_MODEL_REASON } from "./policy/tool-allowlist.ts";
import { blockedAttempts } from "./testing/network-guard.ts";
import { idleTaint, NO_SECRETS } from "./testing/pipeline-bed.ts";
import { createUiBridge } from "./ui-bridge.ts";

const wrongUpdate = PolicyRules.parse({
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  toolAllowlist: null,
  unattended: true,
});

let root: string;
let session: AgentSession | undefined;
let audits: PolicyAuditEntry[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-allow-")));
  for (const dir of ["agent", "project", "home", "pap"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "hi" }] }));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_TELEMETRY", "0");
  vi.stubEnv("PAP_TEST_PROVIDER", "1");
  audits = [];
});
afterEach(() => {
  session?.dispose();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  expect(blockedAttempts).toEqual([]);
});

async function open(allowlist: string[]) {
  const init: InitRecord = {
    type: "init",
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
    papHome: join(root, "pap"),
    umask: 0o022,
    tools: { preset: "read-only", allowlist },
    policy: wrongUpdate,
    testProviderScript: join(root, "script.json"),
  };
  session = await openSession(init, {
    ui: createUiBridge(() => true),
    approvals: createApprovals(() => true),
    // The daemon's rules after a wrong or late policy_update: no list at all.
    rules: () => wrongUpdate,
    rulesVersion: () => 0,
    taint: idleTaint(),
    audit: (entry) => audits.push(entry),
    secrets: NO_SECRETS,
    onEvent: () => {},
    onExtensionError: () => {},
  });
  return session;
}

const call = (s: AgentSession, toolName: string, input: Record<string, unknown>) =>
  s.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "c1", toolName, input });

describe("the worker's pin holds against a rules update without a list (M10R28)", () => {
  it("blocks bash at stage 02 though the rules carry toolAllowlist null", async () => {
    const s = await open(["read"]);
    expect(await call(s, "bash", { command: "echo hi" })).toEqual({
      block: true,
      reason: NOT_ALLOWLISTED_MODEL_REASON,
    });
    expect(audits.at(-1)).toMatchObject({ tool: "bash", decision: "block", reason: NOT_ALLOWLISTED });
    expect(audits.at(-1)?.stages[1]).toMatchObject({ stage: "02", outcome: "block" });
  });
});
