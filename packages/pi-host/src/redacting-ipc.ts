import { UI_LIMITS } from "@pap/contracts/pi-host";
import { errorClass, logLineOf, MAX_WORKER_TEXT } from "./bounded.ts";
import { EDGE_BUDGET, isHeadCut, maskCuts, maskEdges, maskTruncationCopy } from "./policy/edges.ts";
import type { Redactor } from "./policy/redact.ts";
import type { Ipc, Outbound } from "./ipc.ts";

/** The fields pap writes from Pi's own ids and paths: a secret inside a path must not unbind the session file. */
const READY_FIELDS = ["sessionFile", "sessionId"] as const;

/**
 * The lengths at which this worker clips a string it sends (`clipText`, the UI limits). A clip has no marker, so a string
 * of exactly such a length may have been cut inside a secret; any other string was not cut by us.
 */
const CLIP_LENGTHS: ReadonlySet<number> = new Set([
  MAX_WORKER_TEXT,
  UI_LIMITS.noticeText,
  UI_LIMITS.queuePreviewChars,
  UI_LIMITS.statusText,
  UI_LIMITS.widgetLineChars,
  UI_LIMITS.panelLineChars,
  UI_LIMITS.panelInput,
  UI_LIMITS.title,
  UI_LIMITS.name,
  UI_LIMITS.editorText,
]);
/** Fields that name something (an entry, a call, a request, a file): rewriting them breaks the record. */
const isIdentifier = (field: string | undefined): boolean =>
  field !== undefined && (/Id$/.test(field) || ["id", "key", "type", "sessionFile"].includes(field));

type Part = { type?: unknown; text?: unknown };

/**
 * M5R36 and M5R120: the record with every known secret value replaced, the end of a string this worker clipped masked,
 * and the cut edges of a tool output masked. A record whose edges cannot be checked within the budget throws, like any
 * record that cannot be checked: it is never sent reshaped.
 */
export function redactRecord(
  record: Outbound,
  redactor: Redactor,
  isBuiltin: (toolName: string) => boolean,
): Outbound {
  if (redactor.size === 0) return record;
  const budget = { left: EDGE_BUDGET };
  const clippedTail = (text: string, field: string | undefined, original: string): string =>
    CLIP_LENGTHS.has(original.length) && !isIdentifier(field)
      ? maskEdges(text, redactor.entries, budget, { tail: true }).text
      : text;
  let out = redactor.deep(record, { tooDeep: "replace", text: clippedTail }).value as Outbound;
  // A secret inside a path must not unbind the session file.
  if (record.type === "ready") {
    const kept: Record<string, unknown> = {};
    for (const field of READY_FIELDS) if (field in record) kept[field] = record[field];
    out = { ...out, ...kept };
  }
  const live = record.type === "tool_execution_update";
  const key = live ? "partialResult" : record.type === "tool_execution_end" ? "result" : null;
  const holder =
    key === null ? undefined : (out[key] as { content?: unknown; details?: unknown } | null | undefined);
  if (key === null || typeof holder !== "object" || holder === null) return out;
  // A rolling window starts and ends anywhere; a final result lost its start only when bash cut its last line.
  const head = live || isHeadCut(holder.details);
  const cuts = { head, tail: live, notice: record.toolName === "grep" && isBuiltin("grep") };
  const content = Array.isArray(holder.content)
    ? holder.content.map((part: Part | null) =>
        typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string"
          ? { ...part, text: maskCuts(part.text, redactor.entries, budget, cuts).text }
          : part,
      )
    : holder.content;
  const details = head ? maskTruncationCopy(holder.details, redactor.entries, budget).value : holder.details;
  return {
    ...out,
    [key]: {
      ...holder,
      ...("content" in holder ? { content } : {}),
      ...("details" in holder ? { details } : {}),
    },
  };
}

const safeField = (record: Outbound, key: string): unknown => {
  try {
    return record[key];
  } catch {
    return undefined;
  }
};

// Powers of two: the 1st, 2nd, 4th, 8th… dropped record is reported, so stderr grows with the logarithm of the drops.
const worthReporting = (count: number): boolean => (count & (count - 1)) === 0;

/**
 * The `send` the worker's records go through: each carries none of the exact values the secret source knows, and the
 * edges of what this worker clipped or Pi cut are masked. Other writes (stdout, stderr, files) are not covered here. A
 * record that cannot be checked is dropped, and a `response` becomes a failed response so the daemon never waits for it
 * (M5R36).
 */
export function createRedactingIpc(
  ipc: Ipc,
  current: () => Redactor,
  isBuiltin: (toolName: string) => boolean,
): Ipc {
  let dropped = 0;
  const unchecked = (record: Outbound, error: unknown): false => {
    dropped++;
    const type = safeField(record, "type");
    if (worthReporting(dropped))
      process.stderr.write(
        `pi-host: a ${logLineOf(type).slice(0, 64)} record could not be checked for secrets (${errorClass(error)}): dropped\n`,
      );
    const id = safeField(record, "id");
    if (type === "response" && typeof id === "string") {
      const command = safeField(record, "command");
      let name = "unknown";
      try {
        if (typeof command === "string") name = current().text(command.slice(0, 64)).text;
      } catch {
        // Kept "unknown": the failure answer must go out whatever happened to the redactor.
      }
      ipc.send({ type: "response", id, command: name, success: false, error: "record could not be checked" });
    }
    return false;
  };
  return {
    send(record) {
      let checked: Outbound;
      try {
        checked = redactRecord(record, current(), isBuiltin);
      } catch (error) {
        return unchecked(record, error);
      }
      return ipc.send(checked);
    },
    onMessage: (listener, onMalformed) => ipc.onMessage(listener, onMalformed),
    onDisconnect: (listener) => ipc.onDisconnect(listener),
  };
}
