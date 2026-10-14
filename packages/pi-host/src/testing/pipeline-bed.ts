import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_TAINT, type PolicyAuditEntry, PolicyRules } from "@pap/contracts";
import type { ApprovalAsk, ApprovalOutcome } from "../approvals.ts";
import { type ShellFacts, UNKNOWN_SHELL } from "../policy/command-cover.ts";
import { createTaint } from "../policy/taint.ts";
import { createPolicyGrants } from "../policy/grants.ts";
import { evaluateToolCall, type Stages } from "../policy/pipeline.ts";
import { NO_REDACTOR } from "../policy/redact.ts";
import { restoreStage, unrestoreInput } from "../policy/restore.ts";
import type { SecretSource } from "../policy/secrets.ts";
import { createRunGuard, guardStages } from "../policy/run-guard.ts";
import type { ToolFacts } from "../policy/tool-kind.ts";

/** A taint that starts clean and reports to nobody, for a test that is not about taint. */
export const idleTaint = () => createTaint(NO_TAINT, () => {});

/** A secret source that knows nothing, for a test that is not about secrets. */
export const NO_SECRETS: SecretSource = { current: () => NO_REDACTOR, refresh: () => {} };

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
  /** Redacts the reason of a stage verdict and of the entry (case-folded in production). */
  redactReason?: (text: string) => string;
  /** Secret values by name: wires the restore stage (stage 06, M5R119). */
  secretValues?: Readonly<Record<string, string>>;
  /** The shell facts read-only commands depend on; absent: nothing is covered (Task 1c). */
  shell?: ShellFacts;
  /** The session's own id (its attachments are the only ones a read takes unasked). */
  sessionId?: string;
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
          home: base,
          sessionId: () => options.sessionId,
          shell: () => options.shell ?? UNKNOWN_SHELL,
          grants,
          toolFacts: (name) => options.tools?.[name] ?? { path: `builtin:${name}` },
          taint,
          redact: options.redact ?? ((text) => text),
          redactReason: options.redactReason ?? ((text) => text),
          ask: async (request, signal) => {
            asked.push(`${request.title}|${request.message}`);
            asks.push(request);
            return options.ask?.(request, signal) ?? scripted.shift() ?? { answer: "once", closed: false };
          },
          stages: {
            ...guardStages(guard),
            ...(options.secretValues
              ? {
                  restore: restoreStage(() => new Map(Object.entries(options.secretValues ?? {}))),
                  unrestore: unrestoreInput,
                }
              : {}),
            ...options.stages,
          },
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
    /** The directories and the (empty) secret source a policy extension is configured with. */
    config: { agentDir, papHome, secrets: NO_SECRETS },
    /** The location and shell fields of a hand-built `PipelineDeps`; the shell covers nothing. */
    deps: { agentDir, papHome, home: base, shell: () => UNKNOWN_SHELL },
    cwd,
    outside,
    agentDir,
    papHome,
    harness,
    dispose: () => rm(base, { recursive: true, force: true }),
  };
}
