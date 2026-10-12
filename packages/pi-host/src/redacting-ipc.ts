import { logLineOf } from "./bounded.ts";
import { EDGE_WITHHELD_TEXT, maskEdges } from "./policy/edges.ts";
import { errorClass } from "./policy/pipeline.ts";
import type { Redactor } from "./policy/redact.ts";
import type { Ipc, Outbound } from "./ipc.ts";

/** Character comparisons one record may spend on the edges of its live output (M5R120). */
const EDGE_BUDGET = 1_000_000;
/** The fields pap writes from Pi's own ids and paths: a secret inside a path must not unbind the session file. */
const READY_FIELDS = ["sessionFile", "sessionId"] as const;

type Part = { type?: unknown; text?: unknown };

function maskParts(parts: unknown, redactor: Redactor, budget: { left: number }): unknown {
  if (!Array.isArray(parts)) return parts;
  return parts.map((part: Part | null) => {
    if (typeof part !== "object" || part === null || part.type !== "text" || typeof part.text !== "string")
      return part;
    try {
      return { ...part, text: maskEdges(part.text, redactor.entries, budget).text };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { ...part, text: EDGE_WITHHELD_TEXT };
    }
  });
}

/** M5R36 and M5R120: the record with every known secret value replaced, and the cut edges of a live output masked. */
export function redactRecord(record: Outbound, redactor: Redactor): Outbound {
  if (redactor.size === 0) return record;
  let out = redactor.deep(record, { tooDeep: "replace" }).value as Outbound;
  if (record.type === "ready") {
    const kept: Record<string, unknown> = {};
    for (const field of READY_FIELDS) if (field in record) kept[field] = record[field];
    out = { ...out, ...kept };
  }
  const key =
    record.type === "tool_execution_update"
      ? "partialResult"
      : record.type === "tool_execution_end"
        ? "result"
        : null;
  const holder = key === null ? undefined : (out[key] as { content?: unknown } | null | undefined);
  if (key !== null && typeof holder === "object" && holder !== null && "content" in holder) {
    const budget = { left: EDGE_BUDGET };
    out = { ...out, [key]: { ...holder, content: maskParts(holder.content, redactor, budget) } };
  }
  return out;
}

const safeField = (record: Outbound, key: string): unknown => {
  try {
    return record[key];
  } catch {
    return undefined;
  }
};

// Powers of two: the first record is reported, then the 2nd, 4th, 8th…, so a hostile extension cannot flood stderr.
const worthReporting = (count: number): boolean => (count & (count - 1)) === 0;

/**
 * The one `send` of the worker: nothing leaves it holding a value the secret source knows. A record that cannot be
 * checked is dropped, and a `response` becomes a failed response so the daemon never waits for it (M5R36).
 */
export function createRedactingIpc(ipc: Ipc, current: () => Redactor): Ipc {
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
        checked = redactRecord(record, current());
      } catch (error) {
        return unchecked(record, error);
      }
      return ipc.send(checked);
    },
    onMessage: (listener, onMalformed) => ipc.onMessage(listener, onMalformed),
    onDisconnect: (listener) => ipc.onDisconnect(listener),
  };
}
