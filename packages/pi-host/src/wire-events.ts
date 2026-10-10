import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

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

export function toWireEvent(event: AgentSessionEvent): WireEvent {
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
