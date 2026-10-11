import { SessionStreamEvent, type Dialog, type SessionStatus } from "@pap/contracts";

import { sameContent, toMessageView, withUniqueKey, type MessageView } from "./row-view.ts";

export interface SessionView {
  readonly status: SessionStatus;
  readonly messages: readonly MessageView[];
  readonly partialText: string | null;
  readonly dialogs: readonly Dialog[];
  readonly notices: ReadonlyArray<{
    readonly level: string;
    readonly text: string;
    readonly source?: "pap" | "extension";
  }>;
  readonly loaded: boolean;
  /** A snapshot arrived that the contract could not parse: the screen says so instead of staying blank. */
  readonly unreadable: boolean;
}

export const EMPTY_VIEW: SessionView = {
  status: "cold",
  messages: [],
  partialText: null,
  dialogs: [],
  notices: [],
  loaded: false,
  unreadable: false,
};
const MAX_NOTICES = 20;

const withNotice = (
  view: SessionView,
  level: string,
  text: string,
  source?: "pap" | "extension",
): SessionView => ({
  ...view,
  notices: [...view.notices, source ? { level, text, source } : { level, text }].slice(-MAX_NOTICES),
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
  if (!parsed.success) {
    // A snapshot the client cannot read would leave the view blank for ever: say so (M2-RT-06). Other events are dropped.
    return (raw as { kind?: unknown } | null)?.kind === "snapshot"
      ? { ...view, loaded: true, unreadable: true }
      : view;
  }
  const event = parsed.data;
  switch (event.kind) {
    case "snapshot":
      return {
        ...EMPTY_VIEW,
        status: event.status,
        messages: event.rows.reduce<MessageView[]>(
          (list, row) => [...list, withUniqueKey(list, toMessageView(row.message, row.entryId))],
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
      return withNotice(view, event.level, event.text, event.source);
    case "pi":
      return reducePi(view, event.event);
    default:
      return view;
  }
}
