export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  /** The command or the arguments' JSON, cut to 200 characters. */
  readonly summary: string;
  /** The arguments were longer than the summary shows. */
  readonly argsTruncated: boolean;
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
  /** What the model thought, joined; "" when the message has no thinking. */
  readonly thinking: string;
  /** The call a tool result answers, null for any other message. */
  readonly toolCallId: string | null;
  /** A tool result that reports a failure. */
  readonly isError: boolean;
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
const MAX_SUMMARY = 200;
const MAX_NAME = 64;
const MAX_CALL_ID = 256;

const summarize = (args: unknown): { readonly summary: string; readonly argsTruncated: boolean } => {
  const command = (args as { command?: unknown } | null)?.command;
  const text = typeof command === "string" ? command : (JSON.stringify(args ?? {}) ?? "");
  return text.length > MAX_SUMMARY
    ? { summary: `${text.slice(0, MAX_SUMMARY)}…`, argsTruncated: true }
    : { summary: text, argsTruncated: false };
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
    isError?: unknown;
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
      id: clip(String(block.id ?? ""), MAX_CALL_ID),
      name: clip(String(block.name ?? "tool"), MAX_NAME),
      ...summarize(block.arguments ?? block.args ?? block.input),
    }));
  const thinking = blocks
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? block.text)
    .filter((part): part is string => typeof part === "string")
    .join("\n");
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
    thinking,
    toolCallId:
      role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId !== ""
        ? clip(message.toolCallId, MAX_CALL_ID)
        : null,
    isError: role === "toolResult" && message.isError === true,
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

/** The ref fell back to `role:none` (no timestamp): it does not name one message. A tool result is named by its call. */
export const hasFallbackRef = (message: MessageView): boolean =>
  message.toolCallId === null && message.ref.endsWith(":none");

export const sameContent = (a: MessageView, b: MessageView): boolean =>
  a.role === b.role &&
  a.text === b.text &&
  a.thinking === b.thinking &&
  a.isError === b.isError &&
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

/** The message under a key no other message in `list` has. For one live message; a whole list goes through `keyMessages`. */
export function withUniqueKey(list: readonly MessageView[], message: MessageView): MessageView {
  return { ...message, key: uniqueKeyOf(list, message.ref) };
}

/** The key a message with this ref would get if appended to `list`. */
export function uniqueKeyOf(list: readonly MessageView[], ref: string): string {
  const taken = new Map<string, number>();
  for (const existing of list) taken.set(existing.key, 0);
  return takeKey(ref, taken);
}

// `taken` maps each key in use to the highest `#n` suffix already tried for it as a ref, so alike messages stay linear.
function takeKey(ref: string, taken: Map<string, number>): string {
  let key = ref;
  if (taken.has(key)) {
    let n = taken.get(key) ?? 0;
    do key = `${ref}#${++n}`;
    while (taken.has(key));
    taken.set(ref, n);
  }
  taken.set(key, 0);
  return key;
}

const keyOne = (message: MessageView, taken: Map<string, number>): MessageView => ({
  ...message,
  key: takeKey(message.ref, taken),
});

/** Gives every message a key no other has, in one pass over a running map (`taken` is injectable for the cost test). */
export function keyMessages(
  messages: Iterable<MessageView>,
  taken: Map<string, number> = new Map(),
): MessageView[] {
  return Array.from(messages, (message) => keyOne(message, taken));
}
