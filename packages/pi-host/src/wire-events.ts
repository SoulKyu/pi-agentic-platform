import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
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

export function toWireEvent(event: AgentSessionEvent): WireEvent {
  const dropped = WITHOUT_FIELD[event.type];
  if (dropped !== undefined) {
    return Object.fromEntries(Object.entries(event).filter(([key]) => key !== dropped)) as WireEvent;
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
