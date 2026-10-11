export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export type MessageRole =
  "user" | "assistant" | "toolResult" | "compactionSummary" | "branchSummary" | "custom" | "other";

const KNOWN_ROLES: ReadonlySet<unknown> = new Set([
  "user",
  "assistant",
  "toolResult",
  "compactionSummary",
  "branchSummary",
  "custom",
]);

export interface MessageView {
  /** The Pi entry this row came from, null for a live message Pi has not written an entry for yet. */
  readonly entryId: string | null;
  /** Unique in a view: `ref`, plus a counter when another message has the same one. */
  readonly key: string;
  /** What names the message in Pi's data: a tool result by its call, any other by role and time. */
  readonly ref: string;
  readonly role: MessageRole;
  readonly text: string;
  /** How many tokens a compaction summarised, null for any other message. */
  readonly tokensBefore: number | null;
  readonly toolCalls: readonly ToolCallView[];
  /** Why the provider failed (clipped), "" when it gave no reason, null when the message did not fail. */
  readonly error: string | null;
  /** Size in bytes of a row the server did not send because it was too big (a placeholder), null otherwise. */
  readonly omittedBytes: number | null;
  /** How many characters the full tool output has when the preview was cut on the wire, null when it was not. */
  readonly truncatedChars: number | null;
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

const truncatedChars = (marker: unknown): number | null => {
  if (typeof marker !== "object" || marker === null) return null;
  const chars = Number((marker as { chars?: unknown }).chars);
  return Number.isFinite(chars) ? chars : null;
};

/** Null for a message that is not shown: a custom message its extension marked `display: false`. */
export function toMessageView(raw: unknown, entryId: string | null = null): MessageView | null {
  const message = (raw ?? {}) as {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    toolCallId?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    omitted?: unknown;
    bytes?: unknown;
    papTruncated?: unknown;
    summary?: unknown;
    tokensBefore?: unknown;
    display?: unknown;
  };
  if (message.role === "custom" && message.display === false) return null;
  const role = KNOWN_ROLES.has(message.role) ? (message.role as MessageRole) : "other";
  const blocks: Array<Record<string, unknown>> =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>)
        : [];
  const text =
    (role === "compactionSummary" || role === "branchSummary") && typeof message.summary === "string"
      ? message.summary
      : blocks
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
    tokensBefore:
      role === "compactionSummary" &&
      typeof message.tokensBefore === "number" &&
      Number.isFinite(message.tokensBefore)
        ? message.tokensBefore
        : null,
    toolCalls,
    error: failed
      ? clip(typeof message.errorMessage === "string" ? message.errorMessage : "", MAX_ERROR)
      : null,
    omittedBytes: omitted ? (message.bytes as number) : null,
    truncatedChars: truncatedChars(message.papTruncated),
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
