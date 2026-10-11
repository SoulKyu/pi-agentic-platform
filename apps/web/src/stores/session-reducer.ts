import { SessionStreamEvent, type Dialog, type SessionStatus } from "@pap/contracts";

import type { PartialMessage } from "@pap/contracts";

import { failRunningTools, reducePi, withNotice } from "./reduce-pi.ts";
import { toMessageView, withUniqueKey, type MessageView } from "./row-view.ts";

export interface ToolView {
  readonly name: string;
  readonly status: "running" | "done" | "failed";
  /** The tail of what the tool has printed so far (at most 2000 characters). */
  readonly preview: string;
}

export interface SessionView {
  readonly status: SessionStatus;
  readonly messages: readonly MessageView[];
  /** The reply being written, by content index; null between replies. */
  readonly partial: PartialMessage | null;
  /** Tool calls by id, latest wins, oldest first; at most 200. */
  readonly tools: ReadonlyMap<string, ToolView>;
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
  partial: null,
  tools: new Map(),
  dialogs: [],
  notices: [],
  loaded: false,
  unreadable: false,
};
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
        partial: event.partial,
        loaded: true,
      };
    case "status": {
      // A half-written reply of a session that stopped will never be finished.
      const next = {
        ...view,
        status: event.status,
        partial: event.status === "cold" ? null : view.partial,
        tools: event.status === "cold" ? failRunningTools(view.tools) : view.tools,
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
