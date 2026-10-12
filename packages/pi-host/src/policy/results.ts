import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { PolicyAuditEntry, StageVerdict } from "@pap/contracts";
import { errorClass } from "../bounded.ts";
import { FENCE_PLACEHOLDER, fenceText, newFenceId } from "./fence.ts";
import { EDGE_BUDGET, isHeadCut, maskCuts, maskTruncationCopy } from "./edges.ts";
import type { Redactor } from "./redact.ts";
import type { SecretSource } from "./secrets.ts";
import type { ExternalRoots, Taint } from "./taint.ts";
import type { ToolKind } from "./tool-kind.ts";
import { clipUnits } from "./trail.ts";

export const WITHHELD_TEXT = "[pap-policy could not check this tool result, so it was withheld.]";
const MAX_ID = 256;
const MAX_STAGE_REASON = 256;
const MAX_REASON = 1024;
type ResultAuditEntry = Extract<PolicyAuditEntry, { kind: "result" }>;
const STAGE_06_PASS: StageVerdict = { stage: "06", outcome: "pass" };
const STAGE_07_PASS: StageVerdict = { stage: "07", outcome: "pass" };

export interface ResultDeps {
  readonly secrets: SecretSource;
  audit(entry: PolicyAuditEntry): void;
  /** Used by stage 07. */
  classify(name: string): ToolKind;
  readonly taint: Taint;
  readonly roots: ExternalRoots;
  /** Tests only: the real ones by default. */
  newFenceId?(): string;
  fence?(text: string, source: string, id: string): string;
}

function resultEntry(
  event: ToolResultEvent,
  redactions: number,
  stage06: StageVerdict,
  stage07: StageVerdict = STAGE_07_PASS,
): ResultAuditEntry {
  return {
    kind: "result",
    toolCallId: clipUnits(event.toolCallId, MAX_ID),
    ...(event.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: clipUnits(event.parentToolCallId, MAX_ID) }),
    tool: clipUnits(event.toolName, MAX_ID),
    stages: [stage06, stage07],
    redactions,
    external: stage07.outcome === "acted" || stage07.outcome === "block",
  };
}

/**
 * The result with nothing of the original left. Pi keeps `details` when a handler returns none, so an empty object
 * replaces it; it drops `structuredContent` when `content` is replaced alone.
 */
function withheld(
  event: ToolResultEvent,
  deps: ResultDeps,
  error: unknown,
  external: boolean,
): ToolResultEventResult {
  // Never the message: it can quote the value that was being looked for.
  process.stderr.write(`pi-host: tool result withheld (${errorClass(error)})\n`);
  const stage07: StageVerdict = external
    ? raiseVerdict(deps, "session tainted (result withheld)")
    : STAGE_07_PASS;
  try {
    deps.audit(
      resultEntry(
        event,
        0,
        { stage: "06", outcome: "block", reason: "redaction failed: result withheld" },
        stage07,
      ),
    );
  } catch {
    // The audit is what failed, or failed again: the line above says so, and the withheld result is the only safe answer.
  }
  return { content: [{ type: "text", text: WITHHELD_TEXT }], isError: true, details: {} };
}

/** Raises the taint of a result that is external. `raise()` sets the flag before it reports, so a throw after that is a failed report. */
function raiseVerdict(deps: ResultDeps, reason: string): StageVerdict {
  try {
    deps.taint.raise();
    return { stage: "07", outcome: "acted", reason };
  } catch (error) {
    process.stderr.write(`pi-host: taint not raised or not reported (${errorClass(error)})\n`);
    const raised = deps.taint.current();
    return {
      stage: "07",
      outcome: raised ? "acted" : "block",
      reason: raised ? "session tainted; taint report failed" : "taint not raised",
    };
  }
}

/** M5R39. Anything that throws while deciding counts as external: an unknown result is never trusted. */
function isExternal(event: ToolResultEvent, deps: ResultDeps): boolean {
  try {
    const rooted = deps.roots.take(clipUnits(event.toolCallId, MAX_ID));
    const external = deps.classify(event.toolName).external || rooted;
    if (external && event.parentToolCallId !== undefined)
      deps.roots.add(clipUnits(event.parentToolCallId, MAX_ID));
    return external;
  } catch {
    return true;
  }
}

interface Redacted {
  readonly content: ToolResultEvent["content"];
  readonly structured: JsonValue | undefined;
  readonly details: unknown;
  readonly count: number;
}

/** Stage 06 on a result: every text part, `structuredContent` and `details` (M5R36). Throws when it cannot. */
function redactResult(event: ToolResultEvent, deps: ResultDeps): Redacted {
  deps.secrets.refresh();
  const redactor = deps.secrets.current();
  let count = 0;
  // Pi cut the output before this hook ran: what it says it cut may start or end inside a secret.
  const budget = { left: EDGE_BUDGET };
  const headCut = isHeadCut(event.details);
  let head = headCut;
  const notice = deps.classify(event.toolName).builtin && event.toolName === "grep";
  const content = event.content.map((part) => {
    if (part.type !== "text") return part;
    const done = redactor.text(part.text);
    const cut = maskCuts(done.text, redactor.entries, budget, { head, notice });
    head = false;
    count += done.count + cut.count;
    return done.count + cut.count === 0 ? part : { ...part, text: cut.text };
  });
  const structured =
    event.structuredContent === undefined ? undefined : redactor.deep(event.structuredContent);
  const redacted = event.details === undefined ? undefined : redactor.deep(event.details);
  const copy = redacted && headCut ? maskTruncationCopy(redacted.value, redactor.entries, budget) : undefined;
  const details = redacted && {
    value: copy?.value ?? redacted.value,
    count: redacted.count + (copy?.count ?? 0),
  };
  count += (structured?.count ?? 0) + (details?.count ?? 0);
  return {
    content,
    structured: structured && (structured.value as JsonValue),
    details: details?.value,
    count,
  };
}

/** Stage 07: the text parts of an external result go inside a fence, after redaction, so a secret is masked inside it. */
function fenceResult(
  event: ToolResultEvent,
  done: Redacted,
  deps: ResultDeps,
): { result: ToolResultEventResult; verdict: StageVerdict } {
  try {
    const verdict = raiseVerdict(deps, "fenced; session tainted");
    const hasText = done.content.some((part) => part.type === "text");
    if (!hasText)
      return { result: unfenced(done), verdict: { ...verdict, reason: "session tainted (no text)" } };
    const id = (deps.newFenceId ?? newFenceId)();
    const fence = deps.fence ?? fenceText;
    const content = done.content.map((part) =>
      part.type === "text" ? { ...part, text: fence(part.text, event.toolName, id) } : part,
    );
    return { result: unfenced({ ...done, content }), verdict };
  } catch (error) {
    // Fail closed: never an unfenced external result (M5R43).
    process.stderr.write(`pi-host: result fencing failed (${errorClass(error)})\n`);
    try {
      deps.taint.raise();
    } catch {
      // The line above says so; the placeholder is the only safe answer.
    }
    let text = FENCE_PLACEHOLDER;
    try {
      text = fenceText(FENCE_PLACEHOLDER, event.toolName, newFenceId());
    } catch {
      // A bare placeholder holds nothing of the original.
    }
    return {
      result: { content: [{ type: "text", text }], details: {} },
      verdict: { stage: "07", outcome: "block", reason: "fencing failed: result withheld" },
    };
  }
}

function unfenced(done: Redacted): ToolResultEventResult {
  return {
    content: done.content,
    ...(done.structured === undefined ? {} : { structuredContent: done.structured }),
    ...(done.details === undefined ? {} : { details: done.details as Record<string, unknown> }),
  };
}

/**
 * Stage 06 then stage 07 on a result. A throw in 06 withholds the result (M5R37) and, for an external one, still
 * raises the taint. An external result is fenced and raises the taint (M5R39, M5R40, M5R43).
 */
export function onToolResult(event: ToolResultEvent, deps: ResultDeps): ToolResultEventResult | undefined {
  const external = isExternal(event, deps);
  let done: Redacted;
  try {
    done = redactResult(event, deps);
  } catch (error) {
    return withheld(event, deps, error, external);
  }
  const stage06: StageVerdict =
    done.count === 0
      ? STAGE_06_PASS
      : {
          stage: "06",
          outcome: "acted",
          reason: `${done.count} ${done.count === 1 ? "secret" : "secrets"} redacted`,
        };
  try {
    if (!external) {
      if (done.count === 0) return undefined;
      deps.audit(resultEntry(event, done.count, stage06));
      return unfenced(done);
    }
    const fenced = fenceResult(event, done, deps);
    deps.audit(resultEntry(event, done.count, stage06, fenced.verdict));
    return fenced.result;
  } catch (error) {
    return withheld(event, deps, error, external);
  }
}

/**
 * Redacts the reasons of an audit entry, whatever the case: stage 02 writes the judged host in lower case, so an exact
 * match would miss a host that is a secret. The arguments are redacted when they are built (exact match, on the
 * canonical JSON), the ids and tool names are not text the policy wrote.
 */
export function redactAuditReasons(entry: PolicyAuditEntry, redactor: Redactor): PolicyAuditEntry {
  let changed = false;
  // A marker is longer than a short secret: the contract's bounds on a reason still hold.
  const fold = (reason: string | undefined, max: number): string | undefined => {
    if (reason === undefined) return undefined;
    const done = redactor.textFolded(reason);
    if (done.count > 0) changed = true;
    return done.count > 0 ? clipUnits(done.text, max) : reason;
  };
  const stages = entry.stages.map((verdict) => {
    const reason = fold(verdict.reason, MAX_STAGE_REASON);
    return reason === verdict.reason ? verdict : { ...verdict, reason };
  });
  const reason = entry.kind === "call" ? fold(entry.reason, MAX_REASON) : undefined;
  if (!changed) return entry;
  return entry.kind === "call"
    ? { ...entry, stages, ...(reason === undefined ? {} : { reason }) }
    : { ...entry, stages };
}

/** The worker's audit sink with the reasons redacted against the secrets known at that moment. */
export function redactingAuditSink(
  send: (entry: PolicyAuditEntry) => void,
  secrets: SecretSource,
): (entry: PolicyAuditEntry) => void {
  return (entry) => send(redactAuditReasons(entry, secrets.current()));
}
