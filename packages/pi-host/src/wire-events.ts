import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { UI_LIMITS } from "@pap/contracts";
import { clipText } from "./bounded.ts";

export type WireEvent = { type: string } & Record<string, unknown>;

interface RawMessageUpdate {
  readonly message?: { usage?: unknown };
  readonly assistantMessageEvent: Record<string, unknown> & {
    type: string;
    contentIndex?: number;
    partial?: { content?: unknown[] };
  };
}

function toolCallIdentity(
  partial: { content?: unknown[] } | undefined,
  index: number | undefined,
): Record<string, string> {
  const block = typeof index === "number" ? partial?.content?.[index] : undefined;
  if (!block || typeof block !== "object") return {};
  const { id, name } = block as { id?: unknown; name?: unknown };
  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof name === "string" ? { toolName: name } : {}),
  };
}

/**
 * What the daemon is sent for a Pi event. `agent_end` carries every message of the run and `turn_end` the turn's tool
 * results: both grow with the run, so a long one would cross the record limit (`MAX_RECORD_BYTES`) and be lost. The
 * daemon never reads them: it already has each message from `message_end` and tool results from
 * `tool_execution_end`, and the transcript comes from the session file once the run has settled (R103).
 */
const WITHOUT_FIELD: Readonly<Record<string, string>> = { agent_end: "messages", turn_end: "toolResults" };

const SUMMARY_CHARS = 65_536;

const clipped = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

/**
 * What the daemon needs of an appended entry: its place in the tree and what binds it to a message it already saw
 * (`message_end` came first, S1). The body stays here: a tool result can weigh megabytes. Compactions and branch
 * summaries have no message event, so their summary travels (clipped); a custom message travels as its own event.
 */
export function slimEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const base = {
    id: entry.id,
    parentId: entry.parentId ?? null,
    type: entry.type,
    timestamp: entry.timestamp,
  };
  switch (entry.type) {
    case "message": {
      const message = (entry.message ?? {}) as { role?: unknown; toolCallId?: unknown; timestamp?: unknown };
      return {
        ...base,
        ...(typeof message.role === "string" ? { role: message.role } : {}),
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
        ...(typeof message.timestamp === "number" ? { messageTimestamp: message.timestamp } : {}),
      };
    }
    case "compaction":
      return { ...base, summary: clipped(entry.summary, SUMMARY_CHARS), tokensBefore: entry.tokensBefore };
    case "branch_summary":
      return { ...base, summary: clipped(entry.summary, SUMMARY_CHARS), fromId: entry.fromId };
    default:
      return base;
  }
}

function queueOf(event: { steering?: readonly string[]; followUp?: readonly string[] }) {
  const steering = event.steering ?? [];
  const followUp = event.followUp ?? [];
  const preview = (texts: readonly string[]) =>
    texts.slice(0, UI_LIMITS.queueEntries).map((text) => text.slice(0, UI_LIMITS.queuePreviewChars));
  return {
    type: "queue_update",
    steering: preview(steering),
    followUp: preview(followUp),
    count: steering.length + followUp.length,
    bytes: [...steering, ...followUp].reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  };
}

/**
 * Pi echoes the user's message with its images in `message_start` and `message_end`, and a tool result carries its own: three in-budget images weigh
 * over 12 MB, past the record cap, and the daemon never needs the bytes. Each image keeps its type and size.
 */
function withoutImageData(value: unknown, depth = 0): unknown {
  if (typeof value !== "object" || value === null || depth > 6) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => withoutImageData(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    const padding = record.data.endsWith("==") ? 2 : record.data.endsWith("=") ? 1 : 0;
    return {
      type: "image",
      mimeType: record.mimeType,
      omitted: true,
      bytes: Math.max(0, Math.floor((record.data.length * 3) / 4) - padding),
    };
  }
  // A tool result keeps a second copy of an image in `structuredContent`: every image in the value goes.
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, withoutImageData(item, depth + 1)]),
  );
}

export function toWireEvent(event: AgentSessionEvent): WireEvent {
  const dropped = WITHOUT_FIELD[event.type];
  if (dropped !== undefined) {
    return Object.fromEntries(Object.entries(event).filter(([key]) => key !== dropped)) as WireEvent;
  }
  if (event.type === "entry_appended") {
    return { type: "entry_appended", entry: slimEntry(event.entry as unknown as Record<string, unknown>) };
  }
  if (event.type === "queue_update") return queueOf(event as never);
  if (event.type === "message_start" || event.type === "message_end") {
    return { ...event, message: withoutImageData(event.message) } as unknown as WireEvent;
  }
  // A tool result may hold an image too (`read` on a screenshot): same cap, same shape.
  if (event.type === "tool_execution_end") {
    return {
      ...event,
      result: withoutImageData((event as { result?: unknown }).result),
    } as unknown as WireEvent;
  }
  if (event.type === "tool_execution_update") {
    return {
      ...event,
      partialResult: withoutImageData((event as { partialResult?: unknown }).partialResult),
    } as unknown as WireEvent;
  }
  if (event.type !== "message_update") return event as unknown as WireEvent;
  const raw = event as unknown as RawMessageUpdate;
  const { partial, ...rest } = raw.assistantMessageEvent;
  const identity = rest.type === "toolcall_start" ? toolCallIdentity(partial, rest.contentIndex) : {};
  return {
    type: "message_update",
    usage: raw.message?.usage,
    assistantMessageEvent: { ...rest, ...identity },
  };
}

export interface ExtensionErrorFields {
  readonly extensionPath: string;
  readonly event: string;
  readonly error: string;
}

/** The extension_error record, with every string clipped here, where the worker writes it (R66). */
export function toExtensionErrorRecord(fields: ExtensionErrorFields) {
  return {
    type: "extension_error" as const,
    extensionPath: clipText(fields.extensionPath),
    event: clipText(fields.event),
    error: clipText(fields.error),
  };
}
