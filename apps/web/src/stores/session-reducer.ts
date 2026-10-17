import {
  DEFAULT_SESSION_POLICY_VIEW,
  EMPTY_QUEUE,
  type EntryRef,
  type HistoryMeta,
  NO_HISTORY,
  type PartialMessage,
  type QueueView,
  type SessionLoadout,
  type ToolPreset,
  type SessionPolicyView,
  SessionStreamEvent,
  type ChildView,
  type Dialog,
  type SessionStatus,
} from "@pap/contracts";

import { failRunningTools, reducePi, withNotice } from "./reduce-pi.ts";
import { clearedUi, EMPTY_UI, reduceUi, uiOfSnapshot, type UiState } from "./reduce-ui.ts";
import { keyMessages, toMessageView, withUniqueKey, type MessageView } from "./row-view.ts";

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
  /** The key the reply being written will have once Pi writes it, so its row is not remounted; null when unknown. */
  readonly partialKey: string | null;
  /** Tool calls by id, latest wins, oldest first; at most 200. */
  readonly tools: ReadonlyMap<string, ToolView>;
  readonly dialogs: readonly Dialog[];
  /** Open dialogs the snapshot could not carry: something is pending that this view cannot show. */
  readonly hiddenDialogs: number;
  /** A shown dialog closed while others were hidden: the screen asks one fresh snapshot, which resets this. */
  readonly staleDialogs: boolean;
  /** What waits in Pi's steering and follow-up queue; empty while the session is cold. */
  readonly queue: QueueView;
  readonly notices: ReadonlyArray<{
    readonly level: string;
    /** The English text; the screen shows it by `code` in the session's language (R128). */
    readonly text: string;
    readonly source?: "pap" | "extension";
    readonly code?: string;
    readonly params?: Readonly<Record<string, string>>;
  }>;
  /** Why the worker stopped on its own (a crash, an out-of-memory kill), until it comes back: the screen's crash banner. */
  readonly crash: {
    readonly text: string;
    readonly code?: string;
    readonly params?: Readonly<Record<string, string>>;
  } | null;
  /** What lies above the messages: where the next page starts and how many turns it holds. */
  readonly history: HistoryMeta;
  /** Pi's current leaf as far as the stream has said so; null when unknown. */
  readonly leafId: string | null;
  /** The session's folder, from the snapshot ("" until one arrives). */
  readonly cwd: string;
  /** The Pi file changed outside pap in the last 2 minutes, as of the last snapshot (owner Q13). */
  readonly outsideWrite: boolean;
  /** The mode in force and the taint, as the header shows them. */
  readonly policy: SessionPolicyView;
  /** The model, reasoning level and tools the worker last said; null while the session has no worker (M7R44). */
  readonly loadout: SessionLoadout | null;
  /** The session's tool preset as last known, with or without a worker: the snapshot's stored one, then each loadout (MC37). Null before a snapshot or from an older daemon. */
  readonly toolPreset: ToolPreset | null;
  /** The session's subagents, newest first (M11R153); empty from an older daemon. */
  readonly children: readonly ChildView[];
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
  partialKey: null,
  tools: new Map(),
  dialogs: [],
  hiddenDialogs: 0,
  staleDialogs: false,
  queue: EMPTY_QUEUE,
  notices: [],
  crash: null,
  ...EMPTY_UI,
  history: NO_HISTORY,
  leafId: null,
  cwd: "",
  outsideWrite: false,
  policy: DEFAULT_SESSION_POLICY_VIEW,
  loadout: null,
  toolPreset: null,
  children: [],
  loaded: false,
  generation: 0,
  unreadable: false,
};
const appendMessage = (list: readonly MessageView[], message: MessageView | null): readonly MessageView[] =>
  message ? [...list, withUniqueKey(list, message)] : list;

/** The entry Pi wrote for a message the view already has: the oldest one without an id that has its name in Pi's data (Pi writes entries in the order of the messages, so the first of two twins in a millisecond gets the first entry, M4R110). */
function bindEntry(messages: readonly MessageView[], entry: EntryRef): readonly MessageView[] {
  if (entry.type !== "message") return messages;
  const ref =
    entry.role === "toolResult" && entry.toolCallId !== undefined
      ? `toolResult:${entry.toolCallId}`
      : entry.role !== undefined && entry.messageTimestamp !== undefined
        ? `${entry.role}:${entry.messageTimestamp}`
        : null;
  if (ref === null) return messages;
  const index = messages.findIndex((message) => message.entryId === null && message.ref === ref);
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
        messages: keyMessages(event.rows.flatMap((row) => toMessageView(row.message, row.entryId) ?? [])),
        dialogs: event.dialogs,
        hiddenDialogs: event.hiddenDialogs,
        partial: event.partial,
        queue: event.queue,
        notices: event.notices,
        // A snapshot taken while the session is still cold does not say why it stopped: keep what the stream told.
        crash: event.status === "cold" ? view.crash : null,
        ...uiOfSnapshot(event, view),
        history: event.history,
        leafId: event.leafId,
        cwd: event.cwd,
        outsideWrite: event.outsideWrite,
        policy: event.policy,
        loadout: event.loadout,
        toolPreset: event.loadout?.preset ?? event.toolPreset ?? null,
        children: event.children,
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
        loadout: event.status === "cold" ? null : view.loadout,
        tools: event.status === "cold" ? failRunningTools(view.tools) : view.tools,
      };
      if (event.status !== "cold") return { ...next, crash: null };
      return event.cause
        ? {
            ...next,
            crash: {
              text: event.cause,
              ...(event.causeCode ? { code: event.causeCode } : {}),
              ...(event.causeParams ? { params: event.causeParams } : {}),
            },
          }
        : next;
    }
    case "dialog_open":
      return view.dialogs.some((dialog) => dialog.id === event.dialog.id)
        ? view
        : { ...view, dialogs: [...view.dialogs, event.dialog] };
    case "dialog_closed": {
      const shown = view.dialogs.some((dialog) => dialog.id === event.id);
      // An id the view lacks was one of the hidden dialogs. A shown one closing while some are hidden makes the view stale (M4R111).
      if (!shown) return view.hiddenDialogs > 0 ? { ...view, hiddenDialogs: view.hiddenDialogs - 1 } : view;
      return {
        ...view,
        dialogs: view.dialogs.filter((dialog) => dialog.id !== event.id),
        staleDialogs: view.staleDialogs || view.hiddenDialogs > 0,
      };
    }
    case "queue":
      return { ...view, queue: event.queue };
    case "notice":
      return withNotice(view, {
        level: event.level,
        text: event.text,
        ...(event.source ? { source: event.source } : {}),
        ...(event.code ? { code: event.code } : {}),
        ...(event.params ? { params: event.params } : {}),
      });
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
    case "subagents":
      return { ...view, children: event.children };
    case "loadout":
      return { ...view, loadout: event.loadout, toolPreset: event.loadout.preset };
    default:
      return reduceUi(view, event) ?? (event.kind === "policy" ? { ...view, policy: event.policy } : view);
  }
}
