import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry, PolicyRules } from "@pap/contracts";
import type { ApprovalAsk, ApprovalOutcome } from "../approvals.ts";
import { createPolicyGrants, evaluateToolCall } from "../policy/extension.ts";

export const interactiveRules: PolicyRules = {
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  alwaysAllow: [],
};

export interface HarnessOptions {
  /** Replaces the scripted outcomes: answers the policy's question itself. */
  ask?: (request: ApprovalAsk, signal?: AbortSignal) => Promise<ApprovalOutcome>;
  /** Outcomes taken in order, then "once". */
  answers?: ApprovalOutcome[];
  rules?: () => PolicyRules | null;
  /** The rules version the provisional "always" grants are tagged with (default: never changes). */
  rulesVersion?: () => number;
  hasUI?: boolean;
  audit?: (entry: AuditEntry) => void;
  cwd?: string;
  signal?: AbortSignal;
  isBuiltinTool?: (name: string) => boolean;
}

/** Temporary directories for a policy test: `cwd` is the session directory, `outside`, `agentDir` and `papHome` are not. */
export async function createPolicyBed() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pap-policy-")));
  const cwd = join(base, "proj");
  const outside = join(base, "outside");
  const agentDir = join(base, "agent");
  const papHome = join(base, "pap");
  for (const dir of [join(cwd, "src"), outside, agentDir, papHome]) await mkdir(dir, { recursive: true });

  function harness(options: HarnessOptions = {}) {
    const audits: AuditEntry[] = [];
    const asked: string[] = [];
    const asks: ApprovalAsk[] = [];
    const scripted = [...(options.answers ?? [])];
    const grants = createPolicyGrants(options.rulesVersion ?? (() => 0));
    const run = (toolName: string, input: unknown, toolCallId = "c1") =>
      evaluateToolCall(
        { toolCallId, toolName, input },
        {
          hasUI: options.hasUI ?? true,
          cwd: options.cwd ?? cwd,
          signal: options.signal,
        },
        {
          rules: options.rules ?? (() => interactiveRules),
          audit: options.audit ?? ((entry) => audits.push(entry)),
          agentDir,
          papHome,
          grants,
          isBuiltinTool: options.isBuiltinTool ?? (() => true),
          ask: async (request, signal) => {
            asked.push(`${request.title}|${request.message}`);
            asks.push(request);
            return options.ask?.(request, signal) ?? scripted.shift() ?? { answer: "once", closed: false };
          },
        },
      );
    return { audits, asked, asks, run };
  }

  return {
    base,
    cwd,
    outside,
    agentDir,
    papHome,
    harness,
    dispose: () => rm(base, { recursive: true, force: true }),
  };
}
