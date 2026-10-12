import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PolicyAuditEntry, PolicyRules } from "@pap/contracts";
import type { ApprovalAsk, ApprovalOutcome } from "../approvals.ts";
import { createPolicyGrants } from "../policy/grants.ts";
import { evaluateToolCall, type Stages } from "../policy/pipeline.ts";
import { createRunGuard, guardStages } from "../policy/run-guard.ts";
import type { ToolFacts } from "../policy/tool-kind.ts";

export const interactiveRules = PolicyRules.parse({
  profile: "interactive",
  approvalMode: "auto-accept-edits",
});

/** Stage 03 asks Deny / Allow once for every call and never lets a grant skip it: the re-checks are the only thing under test. */
export const ALLOW_ASK: Partial<Stages> = {
  approval: async () => ({ outcome: "ask", reason: "asks", answers: ["deny", "once"], grantable: false }),
};

/** Stage 03 allows every call, so a test of an earlier stage sees only that stage decide. */
export const ALLOW_03: Partial<Stages> = {
  approval: async () => ({ outcome: "allow", reason: "allowed by the test" }),
};

export interface PipelineHarnessOptions {
  /** Replaces the scripted outcomes: answers the policy's question itself. */
  ask?: (request: ApprovalAsk, signal?: AbortSignal) => Promise<ApprovalOutcome>;
  /** Outcomes taken in order, then "once". */
  answers?: ApprovalOutcome[];
  rules?: () => PolicyRules | null;
  rulesVersion?: () => number;
  hasUI?: boolean;
  audit?: (entry: PolicyAuditEntry) => void;
  cwd?: string;
  signal?: AbortSignal;
  /** Registrations by tool name; a name not listed is the built-in of that name. */
  tools?: Readonly<Record<string, ToolFacts>>;
  taint?: boolean | { current(): boolean };
  stages?: Partial<Stages>;
  redact?: (text: string) => string;
}

/** Temporary directories for a pipeline test: `cwd` is the session directory, `outside`, `agentDir` and `papHome` are not. */
export async function createPipelineBed() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pap-pipeline-")));
  const cwd = join(base, "proj");
  const outside = join(base, "outside");
  const agentDir = join(base, "agent");
  const papHome = join(base, "pap");
  for (const dir of [join(cwd, "src"), outside, agentDir, papHome]) await mkdir(dir, { recursive: true });

  function harness(options: PipelineHarnessOptions = {}) {
    const entries: PolicyAuditEntry[] = [];
    const asked: string[] = [];
    const asks: ApprovalAsk[] = [];
    const scripted = [...(options.answers ?? [])];
    const grants = createPolicyGrants(options.rulesVersion ?? (() => 0));
    const guard = createRunGuard();
    const flag = options.taint ?? false;
    const taint = typeof flag === "boolean" ? { current: () => flag } : flag;
    const run = (toolName: string, input: unknown, toolCallId = "c1", parentToolCallId?: string) =>
      evaluateToolCall(
        { toolCallId, toolName, input, parentToolCallId },
        { hasUI: options.hasUI ?? true, cwd: options.cwd ?? cwd, signal: options.signal },
        {
          rules: options.rules ?? (() => interactiveRules),
          rulesVersion: options.rulesVersion ?? (() => 0),
          audit: options.audit ?? ((entry) => entries.push(entry)),
          agentDir,
          papHome,
          grants,
          toolFacts: (name) => options.tools?.[name] ?? { path: `builtin:${name}` },
          taint,
          redact: options.redact ?? ((text) => text),
          ask: async (request, signal) => {
            asked.push(`${request.title}|${request.message}`);
            asks.push(request);
            return options.ask?.(request, signal) ?? scripted.shift() ?? { answer: "once", closed: false };
          },
          stages: { ...guardStages(guard), ...options.stages },
        },
      );
    return {
      entries,
      asked,
      asks,
      run,
      /** Pi's `agent_start`. */
      runStart: () => guard.onRunStart(),
      /** An assistant message ended. */
      turn: () => guard.onTurn(),
    };
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
