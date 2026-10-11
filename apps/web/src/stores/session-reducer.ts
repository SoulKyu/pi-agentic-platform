import { SessionStreamEvent, type Dialog, type SessionStatus } from "@pap/contracts";

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export interface MessageView {
  /** Unique in a view: `ref`, plus a counter when another message has the same one. */
  readonly key: string;
  /** What names the message in Pi's data: a tool result by its call, any other by role and time. */
  readonly ref: string;
  readonly role: "user" | "assistant" | "toolResult" | "other";
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
  /** Why the provider failed (clipped), "" when it gave no reason, null when the message did not fail. */
  readonly error: string | null;
}

export interface SessionView {
  readonly status: SessionStatus;
  readonly messages: readonly MessageView[];
  readonly partialText: string | null;
  readonly dialogs: readonly Dialog[];
  readonly notices: ReadonlyArray<{ readonly level: string; readonly text: string }>;
  readonly loaded: boolean;
}

export const EMPTY_VIEW: SessionView = {
  status: "cold",
  messages: [],
  partialText: null,
  dialogs: [],
  notices: [],
  loaded: false,
};
const MAX_NOTICES = 20;
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

function toMessageView(raw: unknown): MessageView {
  const message = (raw ?? {}) as {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    toolCallId?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
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
  const ref = refOf(message, role);
  return {
    key: ref,
    ref,
    role,
    text,
    toolCalls,
    error: failed
      ? clip(typeof message.errorMessage === "string" ? message.errorMessage : "", MAX_ERROR)
      : null,
  };
}

const sameContent = (a: MessageView, b: MessageView): boolean =>
  a.role === b.role &&
  a.text === b.text &&
  a.error === b.error &&
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
function withUniqueKey(list: readonly MessageView[], message: MessageView): MessageView {
  const taken = new Set(list.map((existing) => existing.key));
  let key = message.ref;
  for (let n = 1; taken.has(key); n++) key = `${message.ref}#${n}`;
  return { ...message, key };
}

const withNotice = (view: SessionView, level: string, text: string): SessionView => ({
  ...view,
  notices: [...view.notices, { level, text }].slice(-MAX_NOTICES),
});

function reducePi(view: SessionView, event: { type: string } & Record<string, unknown>): SessionView {
  switch (event.type) {
    case "message_start":
      return (event.message as { role?: unknown } | undefined)?.role === "assistant"
        ? { ...view, partialText: "" }
        : view;
    case "message_update": {
      const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
      return update?.type === "text_delta" && typeof update.delta === "string"
        ? { ...view, partialText: (view.partialText ?? "") + update.delta }
        : view;
    }
    case "message_end": {
      const message = toMessageView(event.message);
      // The snapshot and the live stream can both carry a message: the same one is not added twice.
      const replay = view.messages.some(
        (existing) => existing.ref === message.ref && sameContent(existing, message),
      );
      return {
        ...view,
        messages: replay ? view.messages : [...view.messages, withUniqueKey(view.messages, message)],
        partialText: message.role === "assistant" ? null : view.partialText,
      };
    }
    case "extension_ui_request":
      return event.method === "notify" && typeof event.message === "string"
        ? withNotice(view, String(event.notifyType ?? "info"), event.message)
        : view;
    default:
      return view;
  }
}

export function reduceSession(view: SessionView, raw: unknown): SessionView {
  const parsed = SessionStreamEvent.safeParse(raw);
  if (!parsed.success) return view;
  const event = parsed.data;
  switch (event.kind) {
    case "snapshot":
      return {
        ...EMPTY_VIEW,
        status: event.status,
        messages: event.messages.reduce<MessageView[]>(
          (list, raw) => [...list, withUniqueKey(list, toMessageView(raw))],
          [],
        ),
        dialogs: event.dialogs,
        loaded: true,
      };
    case "status": {
      // A half-written reply of a session that stopped will never be finished.
      const next = {
        ...view,
        status: event.status,
        partialText: event.status === "cold" ? null : view.partialText,
      };
      return event.cause ? withNotice(next, "error", event.cause) : next;
    }
    case "dialog_open":
      return view.dialogs.some((dialog) => dialog.id === event.dialog.id)
        ? view
        : { ...view, dialogs: [...view.dialogs, event.dialog] };
    case "dialog_closed":
      return { ...view, dialogs: view.dialogs.filter((dialog) => dialog.id !== event.id) };
    case "notice":
      return withNotice(view, event.level, event.text);
    case "pi":
      return reducePi(view, event.event);
  }
}
