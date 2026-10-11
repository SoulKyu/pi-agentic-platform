export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export interface MessageView {
  /** The Pi entry this row came from, null for a live message Pi has not written an entry for yet. */
  readonly entryId: string | null;
  /** Unique in a view: `ref`, plus a counter when another message has the same one. */
  readonly key: string;
  /** What names the message in Pi's data: a tool result by its call, any other by role and time. */
  readonly ref: string;
  readonly role: "user" | "assistant" | "toolResult" | "other";
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
  /** Why the provider failed (clipped), "" when it gave no reason, null when the message did not fail. */
  readonly error: string | null;
  /** Size in bytes of a row the server did not send because it was too big (a placeholder), null otherwise. */
  readonly omittedBytes: number | null;
}

const MAX_ERROR = 500;

const summarize = (args: unknown): string => {
  const command = (args as { command?: unknown } | null)?.command;
  const text = typeof command === "string" ? command : JSON.stringify(args ?? {});
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

const clip = (text: string, max: number): string =>
  text.length > max ? `${[...text.slice(0, max * 2)].slice(0, max).join("")}…` : text;

// A turn's tool results all come in the same millisecond, so time alone cannot tell messages apart.
function refOf(message: { role?: unknown; toolCallId?: unknown; timestamp?: unknown }, role: string): string {
  if (role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId !== "") {
    return `toolResult:${message.toolCallId}`;
  }
  return `${role}:${typeof message.timestamp === "number" ? message.timestamp : "none"}`;
}

export function toMessageView(raw: unknown, entryId: string | null = null): MessageView {
  const message = (raw ?? {}) as {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    toolCallId?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    omitted?: unknown;
    bytes?: unknown;
  };
  const role =
    message.role === "user" || message.role === "assistant" || message.role === "toolResult"
      ? message.role
      : "other";
  const blocks: Array<Record<string, unknown>> =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>)
        : [];
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  const toolCalls = blocks
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      id: String(block.id ?? ""),
      name: String(block.name ?? "tool"),
      summary: summarize(block.arguments ?? block.args ?? block.input),
    }));
  const failed = role === "assistant" && message.stopReason === "error";
  const omitted =
    message.omitted === true && typeof message.bytes === "number" && Number.isFinite(message.bytes);
  const ref = refOf(message, role);
  return {
    entryId,
    key: ref,
    ref,
    role,
    text,
    toolCalls,
    error: failed
      ? clip(typeof message.errorMessage === "string" ? message.errorMessage : "", MAX_ERROR)
      : null,
    omittedBytes: omitted ? (message.bytes as number) : null,
  };
}

export const sameContent = (a: MessageView, b: MessageView): boolean =>
  a.role === b.role &&
  a.text === b.text &&
  a.error === b.error &&
  a.omittedBytes === b.omittedBytes &&
  a.toolCalls.length === b.toolCalls.length &&
  a.toolCalls.every((call, i) => {
    const other = b.toolCalls[i];
    return (
      other !== undefined &&
      call.id === other.id &&
      call.name === other.name &&
      call.summary === other.summary
    );
  });

/** The message under a key no other message in `list` has. */
export function withUniqueKey(list: readonly MessageView[], message: MessageView): MessageView {
  const taken = new Set(list.map((existing) => existing.key));
  let key = message.ref;
  for (let n = 1; taken.has(key); n++) key = `${message.ref}#${n}`;
  return { ...message, key };
}
