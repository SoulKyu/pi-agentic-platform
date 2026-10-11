import {
  EMPTY_QUEUE,
  type EntryRef,
  type HistoryMeta,
  NO_HISTORY,
  type PartialMessage,
  type QueueView,
  SessionStreamEvent,
  type Dialog,
  type SessionStatus,
} from "@pap/contracts";

import { failRunningTools, reducePi, withNotice } from "./reduce-pi.ts";
import { clearedUi, EMPTY_UI, reduceUi, uiOfSnapshot, type UiState } from "./reduce-ui.ts";
import { toMessageView, withUniqueKey, type MessageView } from "./row-view.ts";

export interface ToolView {
  readonly name: string;
  readonly status: "running" | "done" | "failed";
  /** The tail of what the tool has printed so far (at most 2000 characters). */
  readonly preview: string;
}

export interface SessionView extends UiState {
  readonly status: SessionStatus;
  readonly messages: readonly MessageView[];
  /** The reply being written, by content index; null between replies. */
  readonly partial: PartialMessage | null;
  /** Tool calls by id, latest wins, oldest first; at most 200. */
  readonly tools: ReadonlyMap<string, ToolView>;
  readonly dialogs: readonly Dialog[];
  /** Open dialogs the snapshot could not carry: something is pending that this view cannot show. */
  readonly hiddenDialogs: number;
  /** What waits in Pi's steering and follow-up queue; empty while the session is cold. */
  readonly queue: QueueView;
  readonly notices: ReadonlyArray<{
    readonly level: string;
    readonly text: string;
    readonly source?: "pap" | "extension";
  }>;
  /** What lies above the messages: where the next page starts and how many turns it holds. */
  readonly history: HistoryMeta;
  /** Pi's current leaf as far as the stream has said so; null when unknown. */
  readonly leafId: string | null;
  readonly loaded: boolean;
  /** Counts the snapshots this view has had: a page asked for one generation is dropped in another (M2-RT-12). */
  readonly generation: number;
  /** A snapshot arrived that the contract could not parse: the screen says so instead of staying blank. */
  readonly unreadable: boolean;
}

export const EMPTY_VIEW: SessionView = {
  status: "cold",
  messages: [],
  partial: null,
  tools: new Map(),
  dialogs: [],
  hiddenDialogs: 0,
  queue: EMPTY_QUEUE,
  notices: [],
  ...EMPTY_UI,
  history: NO_HISTORY,
  leafId: null,
  loaded: false,
  generation: 0,
  unreadable: false,
};
const appendMessage = (list: readonly MessageView[], message: MessageView | null): readonly MessageView[] =>
  message ? [...list, withUniqueKey(list, message)] : list;

/** The entry Pi wrote for a message the view already has: the newest one without an id that has its name in Pi's data. */
function bindEntry(messages: readonly MessageView[], entry: EntryRef): readonly MessageView[] {
  if (entry.type !== "message") return messages;
  const ref =
    entry.role === "toolResult" && entry.toolCallId !== undefined
      ? `toolResult:${entry.toolCallId}`
      : entry.role !== undefined && entry.messageTimestamp !== undefined
        ? `${entry.role}:${entry.messageTimestamp}`
        : null;
  if (ref === null) return messages;
  const index = messages.findLastIndex((message) => message.entryId === null && message.ref === ref);
  const found = messages[index];
  return found ? messages.with(index, { ...found, entryId: entry.id }) : messages;
}

export function reduceSession(view: SessionView, raw: unknown): SessionView {
  const parsed = SessionStreamEvent.safeParse(raw);
  if (!parsed.success) {
    // A snapshot the client cannot read would leave the view blank for ever: say so (M2-RT-06). Other events are dropped.
    return (raw as { kind?: unknown } | null)?.kind === "snapshot"
      ? { ...view, loaded: true, unreadable: true, generation: view.generation + 1 }
      : view;
  }
  const event = parsed.data;
  switch (event.kind) {
    case "snapshot":
      return {
        ...EMPTY_VIEW,
        status: event.status,
        messages: event.rows.reduce<readonly MessageView[]>(
          (list, row) => appendMessage(list, toMessageView(row.message, row.entryId)),
          [],
        ),
        dialogs: event.dialogs,
        hiddenDialogs: event.hiddenDialogs,
        partial: event.partial,
        queue: event.queue,
        notices: event.notices,
        ...uiOfSnapshot(event, view),
        history: event.history,
        leafId: event.leafId,
        loaded: true,
        generation: view.generation + 1,
      };
    case "status": {
      // A half-written reply of a session that stopped will never be finished.
      const base = event.status === "cold" ? clearedUi(view) : view;
      const next = {
        ...base,
        status: event.status,
        partial: event.status === "cold" ? null : view.partial,
        queue: event.status === "cold" ? EMPTY_QUEUE : view.queue,
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
    case "queue":
      return { ...view, queue: event.queue };
    case "notice":
      return withNotice(view, event.level, event.text, event.source);
    case "pi":
      return reducePi(view, event.event);
    case "entry":
      return { ...view, messages: bindEntry(view.messages, event.entry), leafId: event.entry.id };
    case "row":
      return event.row.entryId !== null &&
        view.messages.some((message) => message.entryId === event.row.entryId)
        ? view
        : {
            ...view,
            messages: appendMessage(view.messages, toMessageView(event.row.message, event.row.entryId)),
          };
    default:
      return reduceUi(view, event) ?? view;
  }
}
