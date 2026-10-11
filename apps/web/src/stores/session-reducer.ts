import { SessionStreamEvent, type Dialog, type SessionStatus } from "@pap/contracts";

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export interface MessageView {
  readonly key: string;
  readonly role: "user" | "assistant" | "toolResult" | "other";
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
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

const summarize = (args: unknown): string => {
  const command = (args as { command?: unknown } | null)?.command;
  const text = typeof command === "string" ? command : JSON.stringify(args ?? {});
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

export function toMessageView(raw: unknown, index: number): MessageView {
  const message = (raw ?? {}) as { role?: unknown; content?: unknown; timestamp?: unknown };
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
  return {
    key: typeof message.timestamp === "number" ? `${role}:${message.timestamp}` : `${role}:#${index}`,
    role,
    text,
    toolCalls,
  };
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
      const message = toMessageView(event.message, view.messages.length);
      const known = view.messages.some((existing) => existing.key === message.key);
      return {
        ...view,
        messages: known ? view.messages : [...view.messages, message],
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
        messages: event.messages.map(toMessageView),
        dialogs: event.dialogs,
        loaded: true,
      };
    case "status": {
      const next = { ...view, status: event.status };
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
