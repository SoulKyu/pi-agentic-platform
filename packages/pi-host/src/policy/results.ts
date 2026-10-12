import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { PolicyAuditEntry, StageVerdict } from "@pap/contracts";
import { errorClass } from "./pipeline.ts";
import type { Redactor } from "./redact.ts";
import type { SecretSource } from "./secrets.ts";
import type { ToolKind } from "./tool-kind.ts";
import { clipUnits } from "./trail.ts";

export const WITHHELD_TEXT = "[pap-policy could not check this tool result, so it was withheld.]";
const MAX_ID = 256;
const MAX_STAGE_REASON = 256;
const MAX_REASON = 1024;
type ResultAuditEntry = Extract<PolicyAuditEntry, { kind: "result" }>;
const STAGE_07_NOT_IN_FORCE: StageVerdict = { stage: "07", outcome: "skip", reason: "not in force" };

export interface ResultDeps {
  readonly secrets: SecretSource;
  audit(entry: PolicyAuditEntry): void;
  /** Used by stage 07 (Task 9). */
  classify(name: string): ToolKind;
}

function resultEntry(event: ToolResultEvent, redactions: number, stage06: StageVerdict): ResultAuditEntry {
  return {
    kind: "result",
    toolCallId: clipUnits(event.toolCallId, MAX_ID),
    ...(event.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: clipUnits(event.parentToolCallId, MAX_ID) }),
    tool: clipUnits(event.toolName, MAX_ID),
    stages: [stage06, STAGE_07_NOT_IN_FORCE],
    redactions,
    external: false,
  };
}

/**
 * The result with nothing of the original left. Pi keeps `details` when a handler returns none, so an empty object
 * replaces it; it drops `structuredContent` when `content` is replaced alone.
 */
function withheld(event: ToolResultEvent, deps: ResultDeps, error: unknown): ToolResultEventResult {
  // Never the message: it can quote the value that was being looked for.
  process.stderr.write(`pi-host: tool result withheld (${errorClass(error)})\n`);
  try {
    deps.audit(
      resultEntry(event, 0, { stage: "06", outcome: "block", reason: "redaction failed: result withheld" }),
    );
  } catch {
    // The audit is what failed, or failed again: the line above says so, and the withheld result is the only safe answer.
  }
  return { content: [{ type: "text", text: WITHHELD_TEXT }], isError: true, details: {} };
}

/** Stage 06 on a result: every text part, `structuredContent` and `details` (M5R36). A throw withholds the result (M5R37). */
export function onToolResult(event: ToolResultEvent, deps: ResultDeps): ToolResultEventResult | undefined {
  try {
    deps.secrets.refresh();
    const redactor = deps.secrets.current();
    let count = 0;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const done = redactor.text(part.text);
      count += done.count;
      return done.count === 0 ? part : { ...part, text: done.text };
    });
    const structured =
      event.structuredContent === undefined ? undefined : redactor.deep(event.structuredContent);
    const details = event.details === undefined ? undefined : redactor.deep(event.details);
    count += (structured?.count ?? 0) + (details?.count ?? 0);
    if (count === 0) return undefined;
    deps.audit(
      resultEntry(event, count, {
        stage: "06",
        outcome: "acted",
        reason: `${count} ${count === 1 ? "secret" : "secrets"} redacted`,
      }),
    );
    return {
      content,
      ...(structured === undefined ? {} : { structuredContent: structured.value as JsonValue }),
      ...(details === undefined ? {} : { details: details.value }),
    };
  } catch (error) {
    return withheld(event, deps, error);
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
