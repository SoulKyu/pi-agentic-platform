import type { ApprovalMode } from "@pap/contracts";
import {
  agentOwnOf,
  hasOwnFolder,
  isolatedPlan,
  judgedAs,
  OUTSIDE_FOLDER_REASON,
  readsOutsideThread,
  SANDBOXED_SHELL_REASON,
} from "./agent-stage.ts";
import { coverCommand } from "./command-cover.ts";
import type { ApprovalPlan, CallFacts, PipelineDeps, PolicyContext } from "./pipeline.ts";
import { decide } from "./decide.ts";
import { networkRequestPlan } from "./network-request-plan.ts";
import { checkReadTarget } from "./read-target.ts";
import { READ_ONLY_REASON } from "./reasons.ts";
import { checkEditTarget, type EditReview } from "./target-path.ts";
import { vmFileRefusal } from "./vm-stage.ts";

const READ_FILE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

const inputPath = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? (input as { path?: unknown }).path : undefined;

/** M7R11: where a covered shell command runs like a built-in read. */
export const READ_ONLY_COMMAND_MODES: ReadonlySet<ApprovalMode> = new Set([
  "supervised",
  "auto-accept-edits",
]);
export const READ_ONLY_COMMAND_REASON = "read-only command";

/** Decision 75 Q6: Pi's own bash, a mode that allows reads, the owner's switch, and every simple command covered. */
async function readOnlyCommand(call: CallFacts, ctx: PolicyContext, deps: PipelineDeps): Promise<boolean> {
  if (!call.exec || call.event.toolName !== "bash") return false;
  if (!call.rules.readOnlyCommands || !READ_ONLY_COMMAND_MODES.has(call.rules.approvalMode)) return false;
  const command = (call.event.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  const cover = await coverCommand(command, {
    cwd: ctx.cwd,
    home: deps.home,
    papHome: deps.papHome,
    agentDir: deps.agentDir,
    sessionId: deps.sessionId?.(),
    shell: deps.shell(),
    readOnly: true,
    tainted: call.tainted,
  });
  return cover.covered;
}

/** A write outside the folder or to a protected path (R14); a built-in read of pap's own files (M5R29). */
async function reviewOf(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<{ review?: EditReview; protectedRead?: EditReview }> {
  // No host protected root exists in a VM: the VM file rule decided (stage 03 ran `vmFileRefusal` first).
  if (deps.vm) return {};
  const { category } = judgedAs(call);
  if (category === "edit") {
    // pap's sandboxed shell names no path: bwrap confines it to its one writable folder (M11R30).
    if (call.kind.sandboxed === true) return {};
    const check = await checkEditTarget(
      inputPath(call.event.input),
      ctx.cwd,
      [deps.agentDir, deps.papHome],
      deps.papHome,
      agentOwnOf(call.rules),
    );
    return check.auto ? {} : { review: check.review };
  }
  if (category !== "read" || !call.kind.builtin) return {};
  const protectedRead = await checkReadTarget(call.event.toolName, call.event.input, {
    cwd: ctx.cwd,
    papHome: deps.papHome,
    agentDir: deps.agentDir,
    sessionId: deps.sessionId?.(),
    profile: call.rules.profile,
    agentHome: call.rules.agentHome,
    agentScratch: call.rules.agentScratch,
  });
  return protectedRead ? { protectedRead } : {};
}

/** What `approvalStage` found out about a built-in read of pap's own files, by call: the MQ6 re-check needs it. */
const PROTECTED_READS = new WeakMap<CallFacts, string>();

/**
 * MQ6: whether a call a person answered must still be refused because the rules moved to read-only while the question
 * was open. `now` is the call under the new rules and taint; `call` the one the stage judged. Same rule as `decide`.
 */
export function readOnlyRefusal(
  call: CallFacts,
  now: CallFacts,
): { reason: string; modelReason: string } | null {
  const verdict = decide({
    mode: "read-only",
    category: now.kind.category,
    tainted: now.tainted,
    external: now.kind.external,
    protectedRead: PROTECTED_READS.get(call),
  });
  return verdict.decision === "block" ? { reason: "read-only", modelReason: READ_ONLY_REASON } : null;
}

const PRESET_ASK_REASON = "read-only preset: not a read";

export const TRUSTED_AUTONOMY_REASON = "trusted autonomy";

const DELEGATE_NOTE =
  "If you allow it, the other agent runs it as an isolated task (read tools, its home read-only), not in its thread.";

/**
 * M11R14: a call of pap's own platform tools (stage 02 classified it by source and name). Untainted, or an op that runs
 * when tainted: allowed in every mode, since the op decides nothing on the filesystem. Tainted and `ask`: Deny / Allow
 * once, no grant (only a browser session's Allow once counts in the daemon, owner m15). `refuse`: blocked.
 */
export function platformPlan(call: CallFacts): ApprovalPlan | null {
  const platform = call.kind.platform;
  if (!platform) return null;
  if (platform.op === "network.request") return networkRequestPlan(call);
  if (!call.tainted || platform.whenTainted === "run")
    return { outcome: "allow", reason: "pap platform call" };
  // Owner a6 (ii): the daemon composes `autonomy` for an agent thread only; an isolated task never reaches here.
  if (platform.whenTainted === "ask" && call.rules.autonomy !== null && call.rules.profile === "agent-thread")
    return { outcome: "allow", reason: TRUSTED_AUTONOMY_REASON };
  const tool = call.event.toolName;
  const reason = `This session read external content. ${tool} can carry it into another agent's work.`;
  if (platform.whenTainted === "refuse")
    return {
      outcome: "block",
      reason,
      modelReason: `pap-policy blocked ${tool}: this session read external content.`,
    };
  return {
    outcome: "ask",
    title: `pap: ${tool} after external content`,
    reason: platform.op === "agent.delegate" ? `${reason} ${DELEGATE_NOTE}` : reason,
    answers: ["deny", "once"],
    grantable: false,
  };
}

/**
 * M7 Task 15 (MC36): under the read-only preset a call whose category is not `read` (an `unknown` extension tool, an
 * extension that took a built-in's name, anything else the matrix would let run) is never let through unasked, in every
 * approval mode, `full-access` included, whatever the matrix said short of a block. No grant or always rule skips the question. MCP writes are blocked earlier, at stage 02.
 */
function heldByPreset(call: CallFacts): boolean {
  return call.rules.readOnlyPreset && call.kind.category !== "read";
}

/** Stage 03: the approval matrix (`decide`) over the facts of the call. It never puts input text in a reason. */
export async function approvalStage(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<ApprovalPlan> {
  const { profile } = call.rules;
  if (deps.vm) {
    const refusal = await vmFileRefusal(call, ctx, deps.vm);
    if (refusal) return refusal;
  }
  // An isolated task is unattended: its own table, nothing a grant or a person's habit can loosen (M11R32).
  if (profile === "isolated-task") return isolatedPlan(call, ctx, deps);
  const { category, external } = judgedAs(call);
  // A shell whose one writable folder the rules do not name (or name wrongly) never runs (M3).
  if (profile !== "interactive" && call.kind.sandboxed === true && !(await hasOwnFolder(call, ctx, deps)))
    return {
      outcome: "block",
      reason: "no agent folder for the shell",
      modelReason: "pap-policy blocked this shell call.",
    };
  const attended = profile === "interactive" || profile === "agent-thread";
  if (attended && (await readOnlyCommand(call, ctx, deps))) {
    // M7R12: a read, never external: taint asks only for what can carry data out.
    const verdict = decide({
      mode: call.rules.approvalMode,
      category: "read",
      tainted: call.tainted,
      external: false,
    });
    if (verdict.decision === "allow" && !heldByPreset(call))
      return { outcome: "allow", reason: READ_ONLY_COMMAND_REASON };
  }
  const platformDecision = platformPlan(call);
  if (platformDecision) return platformDecision;
  // W5-R63: an agent thread's built-in file tools stay in its home, its attachments and the system view, in every mode.
  if (
    profile === "agent-thread" &&
    category === "read" &&
    call.kind.builtin &&
    READ_FILE_TOOLS.has(call.event.toolName) &&
    (await readsOutsideThread(call, ctx, deps))
  )
    return {
      outcome: "block",
      reason: OUTSIDE_FOLDER_REASON,
      modelReason: `pap-policy blocked this ${category} call: ${OUTSIDE_FOLDER_REASON}.`,
    };
  const { review, protectedRead } = await reviewOf(call, ctx, deps);
  if (protectedRead) PROTECTED_READS.set(call, protectedRead.why);
  // Rules of a profile this build does not know open nothing: fail closed.
  if (!attended)
    return {
      outcome: "block",
      reason: review?.why ?? protectedRead?.why ?? `${category} blocked`,
      modelReason: `pap-policy blocked this ${category} call.`,
    };
  const input = {
    mode: call.rules.approvalMode,
    category,
    external,
    review,
    protectedRead: protectedRead?.why,
  };
  const verdict = decide({ ...input, tainted: call.tainted });
  // M11R241: allowed only because autonomy lifted the taint question: the row says so.
  const byAutonomy =
    call.autonomyLifted === true &&
    verdict.decision === "allow" &&
    decide({ ...input, tainted: true }).decision !== "allow";
  const shown = review ?? protectedRead;
  // Whatever the matrix said short of a block (allow, or its own grantable question), the preset's question is the only
  // one: Deny / Allow once, and nothing a grant or an always rule remembered can skip it.
  if (verdict.decision !== "block" && heldByPreset(call))
    return {
      outcome: "ask",
      reason: verdict.decision === "ask" ? verdict.why : PRESET_ASK_REASON,
      answers: ["deny", "once"],
      ...(shown ? { review: shown } : {}),
      grantable: false,
    };
  if (verdict.decision === "allow") {
    const shell = category === "edit" && call.kind.sandboxed === true;
    return {
      outcome: "allow",
      reason: byAutonomy ? TRUSTED_AUTONOMY_REASON : shell ? SANDBOXED_SHELL_REASON : verdict.why,
    };
  }
  if (verdict.decision === "block")
    return {
      outcome: "block",
      reason: verdict.why,
      modelReason:
        call.rules.approvalMode === "read-only"
          ? READ_ONLY_REASON
          : `pap-policy blocked this ${category} call.`,
    };
  return {
    outcome: "ask",
    reason: verdict.why,
    answers: verdict.answers,
    ...(shown ? { review: shown } : {}),
    grantable: verdict.grantable,
  };
}
