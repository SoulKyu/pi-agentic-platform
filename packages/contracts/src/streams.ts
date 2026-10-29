import { z } from "zod";

export const STREAMS = [
  "session",
  "shell",
  "vcs",
  "terminal",
  "login",
  "lane",
  "tasks",
  "inbox",
  "usage",
  "agents",
  "ops",
  "launches",
  "previews",
] as const;
export type StreamName = (typeof STREAMS)[number];

export const SessionStatus = z.enum(["cold", "starting", "idle", "running", "releasing"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

import { AlwaysScope, ApprovalAnswer, DEFAULT_SESSION_POLICY_VIEW, SessionPolicyView } from "./policy.ts";
import { LoginEvent } from "./models-methods.ts";
import { SessionCost } from "./session-cost.ts";
import { SessionLoadout, ToolPreset } from "./session-loadout.ts";
import { CHILD_VIEWS, ChildView } from "./children.ts";
import { Dialog } from "./dialog.ts";

/**
 * The most the daemon passes on from a worker for each extension UI surface (R66). The daemon rebuilds every client
 * event from the fields it knows, cut to these, so an extension that loops or lies cannot grow a frame or a snapshot.
 * They count characters; the snapshot also bounds decorations in bytes (Task 1b).
 */
export const UI_LIMITS = {
  statuses: 32,
  statusKey: 256,
  statusText: 512,
  widgets: 8,
  widgetKey: 256,
  widgetLines: 50,
  widgetLineChars: 512,
  title: 256,
  editorText: 200_000,
  panels: 4,
  panelLines: 200,
  panelLineChars: 512,
  panelInput: 4096,
  notices: 20,
  noticeText: 2000,
  queuePreviewChars: 2000,
  queueEntries: 128,
  name: 256,
} as const;

/**
 * A session name, as the daemon's `nameOf` clips it: at most `UI_LIMITS.name` code points. `.max` counts UTF-16 units,
 * so it only bounds the work of counting code points (a name of 256 emoji is 512 units).
 */
export const SessionName = z
  .string()
  .max(UI_LIMITS.name * 2)
  .refine((name) => [...name].length <= UI_LIMITS.name, "a session name is at most 256 characters");

export const DialogResponse = z.union([
  z.object({ confirmed: z.boolean() }),
  z.object({ value: z.string().max(1_000_000) }),
  z.object({ cancelled: z.literal(true) }),
  z.object({ answer: ApprovalAnswer, scope: AlwaysScope.optional() }),
]);
export type DialogResponse = z.infer<typeof DialogResponse>;

export const PiEvent = z.looseObject({ type: z.string() });
export type PiEvent = z.infer<typeof PiEvent>;

/** One displayed transcript row: a Pi message (or summary) and the id of the Pi entry it came from, once known. */
export const TranscriptRow = z.object({
  entryId: z.string().min(1).max(128).nullable(),
  message: z.unknown(),
  /** A user entry of a VM session that pap did not send (R32): shown as such. */
  unverified: z.literal(true).optional(),
});
export type TranscriptRow = z.infer<typeof TranscriptRow>;

export const PartialBlock = z.object({
  type: z.enum(["text", "thinking", "toolCall"]),
  text: z.string(),
  id: z.string().max(256).optional(),
  name: z.string().max(256).optional(),
});
export type PartialBlock = z.infer<typeof PartialBlock>;
/** The assistant reply being written, by content index: what a client resuming mid-reply starts from (spec C §4.3). */
export const PartialMessage = z.object({ blocks: z.array(PartialBlock).max(64) });
export type PartialMessage = z.infer<typeof PartialMessage>;

export const StatusEntry = z.object({
  key: z.string().min(1).max(UI_LIMITS.statusKey),
  text: z.string().max(UI_LIMITS.statusText),
});
export type StatusEntry = z.infer<typeof StatusEntry>;
export const Widget = z.object({
  key: z.string().min(1).max(UI_LIMITS.widgetKey),
  lines: z.array(z.string().max(UI_LIMITS.widgetLineChars)).max(UI_LIMITS.widgetLines),
  placement: z.enum(["aboveEditor", "belowEditor"]),
});
export type Widget = z.infer<typeof Widget>;
export const Panel = z.object({
  id: z.string().min(1).max(128),
  lines: z.array(z.string().max(UI_LIMITS.panelLineChars)).max(UI_LIMITS.panelLines),
});
export type Panel = z.infer<typeof Panel>;
/**
 * The stable id of a sentence pap writes itself (R128), so a client can show it in its own language. The English `text`
 * stays beside it. A code is open-ended on the wire: a client shows the English text for a code it does not know, and a
 * daemon that sends none (older) is read by the pattern fallback.
 */
export const SERVER_CODES = {
  messageTooLarge: "message_too_large",
  dialogTooLarge: "dialog_too_large",
  dialogLimit: "dialog_limit",
  approvalUnshown: "approval_unshown",
  extensionFailed: "extension_failed",
  extensionFailedDuring: "extension_failed_during",
  /** The same, with the extension's short name (a package name or a file name) beside the event. */
  extensionFailedNamed: "extension_failed_named",
  /** An extension registered a tool name pap provides itself; pap's tool is the one in use. Not a failure. */
  extensionOverride: "extension_override",
  panelsLimit: "panels_limit",
  noticesHeldOne: "notices_held_one",
  noticesHeldMany: "notices_held_many",
  rulesFull: "rules_full",
  rulesNotSaved: "rules_not_saved",
  viewNotRefreshed: "view_not_refreshed",
  processStopped: "process_stopped",
  processExitCode: "process_exit_code",
  processSignal: "process_signal",
  processSignalUnknown: "process_signal_unknown",
  processKilled: "process_killed",
  processOom: "process_oom",
  processSpawnFailure: "process_spawn_failure",
  /** An agent's saved model was refused by its worker; `running` names the model the thread runs on. */
  agentModelRefused: "agent_model_refused",
  /** The same, when the worker said no model: the thread runs on Pi's default. */
  agentModelRefusedDefault: "agent_model_refused_default",
  /** Refused in Chat only, which loads no extension: the selection is not what decides. */
  agentModelRefusedChat: "agent_model_refused_chat",
  /** The worker did not answer the model change, or failed it otherwise (a timeout, a failed key check). */
  agentModelNotApplied: "agent_model_not_applied",
} as const;
export const ServerCode = z.string().min(1).max(64);
/** Values for the `{name}` slots of the client's sentence: short strings, at most four. */
export const ServerParams = z
  .record(z.string().min(1).max(32), z.string().max(64))
  .refine((params) => Object.keys(params).length <= 4, "at most four params");
/** A sentence of pap's own with its stable code: what an emitter hands to the stream next to the English text. */
export interface ServerText {
  readonly text: string;
  readonly code: string;
  readonly params?: Readonly<Record<string, string>>;
}
export const Notice = z.object({
  level: z.enum(["info", "warning", "error"]),
  text: z.string().max(UI_LIMITS.noticeText),
  /** Present on pap's own fixed sentences; never on an extension's text. */
  code: ServerCode.optional(),
  params: ServerParams.optional(),
  /** `extension`: the text is an extension's own (`ctx.ui.notify`), labelled so in the UI (owner R2-8). Absent: pap's text. */
  source: z.enum(["pap", "extension"]).optional(),
});
export type Notice = z.infer<typeof Notice>;
/** Previews of what waits in Pi's queue, and how much (Task 12). The texts themselves stay in the worker. */
export const QueueView = z.object({
  steering: z.array(z.string().max(UI_LIMITS.queuePreviewChars)).max(UI_LIMITS.queueEntries),
  followUp: z.array(z.string().max(UI_LIMITS.queuePreviewChars)).max(UI_LIMITS.queueEntries),
  count: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type QueueView = z.infer<typeof QueueView>;
export const HistoryMeta = z.object({
  hasMore: z.boolean(),
  oldestEntryId: z.string().max(128).nullable(),
  turnsBefore: z.number().int().nonnegative(),
});
export type HistoryMeta = z.infer<typeof HistoryMeta>;
export const Activity = z.object({
  compacting: z.boolean(),
  retry: z
    .object({ attempt: z.number().int().nonnegative(), maxAttempts: z.number().int().nonnegative() })
    .nullable(),
});
export type Activity = z.infer<typeof Activity>;
/** A Pi entry as the client needs it: its id binds a live message to the entry Pi wrote for it. */
export const EntryRef = z.object({
  id: z.string().min(1).max(128),
  parentId: z.string().max(128).nullable(),
  type: z.string().max(64),
  role: z.string().max(64).optional(),
  toolCallId: z.string().max(256).optional(),
  messageTimestamp: z.number().optional(),
});
export type EntryRef = z.infer<typeof EntryRef>;

/** One child at a fork: `target` is the leaf a switch to it goes to (the newest entry under it). */
export const ForkChoice = z.object({
  entryId: z.string().max(128),
  preview: z.string().max(120),
  target: z.string().max(128),
  timestamp: z.string().max(64).nullable(),
  onPath: z.boolean(),
});
export type ForkChoice = z.infer<typeof ForkChoice>;
export const ForkPoint = z.object({
  parentId: z.string().max(128).nullable(),
  choices: z.array(ForkChoice).max(16),
});
export type ForkPoint = z.infer<typeof ForkPoint>;

export const EMPTY_QUEUE: QueueView = { steering: [], followUp: [], count: 0, bytes: 0 };
export const IDLE_ACTIVITY: Activity = { compacting: false, retry: null };
export const NO_HISTORY: HistoryMeta = { hasMore: false, oldestEntryId: null, turnsBefore: 0 };

const Snapshot = z.object({
  kind: z.literal("snapshot"),
  status: SessionStatus,
  rows: z.array(TranscriptRow),
  dialogs: z.array(Dialog),
  /** Dialogs (approvals included) still open that did not fit the snapshot: something is pending that this one cannot show. */
  hiddenDialogs: z.number().int().nonnegative().default(0),
  partial: PartialMessage.nullable(),
  queue: QueueView,
  statuses: z.array(StatusEntry).max(UI_LIMITS.statuses),
  widgets: z.array(Widget).max(UI_LIMITS.widgets),
  title: z.string().max(UI_LIMITS.title).nullable(),
  panels: z.array(Panel).max(UI_LIMITS.panels),
  notices: z.array(Notice).max(UI_LIMITS.notices),
  /** Statuses, notices, widgets or panels were left out to keep the snapshot under its limits and budget (Task 1b). */
  decorationsTruncated: z.boolean(),
  history: HistoryMeta,
  activity: Activity,
  leafId: z.string().max(128).nullable(),
  name: SessionName.nullable(),
  /** The session's working directory (M4): the session screen needs no list to find it. `""` from an older daemon. */
  cwd: z.string().max(4096).default(""),
  /** The session's Pi file changed in the last 2 minutes outside pap (owner Q13, M4R141). `false` from an older daemon. */
  outsideWrite: z.boolean().default(false),
  policy: SessionPolicyView.default(DEFAULT_SESSION_POLICY_VIEW),
  /** The model, reasoning level and tools the worker last said; `null` while the session has no worker (M7R44). */
  loadout: SessionLoadout.nullable().default(null),
  /** The preset stored for the session, known with or without a worker (MC37); `configured` from an older daemon. */
  toolPreset: ToolPreset.default("configured"),
  /** The session's subagents, the newest eight, with their open dialogs (M11R140); empty from an older daemon. */
  children: z.array(ChildView).max(CHILD_VIEWS).default([]),
  /** Children whose line did not fit the snapshot's room: they exist but are not listed here; 0 from an older daemon. */
  hiddenChildren: z.number().int().nonnegative().max(CHILD_VIEWS).default(0),
  /** What the session has cost so far; `null` when it has had no run, and from an older daemon (UX-1). */
  cost: SessionCost.nullable().default(null),
});

export const SessionStreamEvent = z.discriminatedUnion("kind", [
  Snapshot,
  z.object({
    kind: z.literal("status"),
    status: SessionStatus,
    cause: z.string().max(256).optional(),
    causeCode: ServerCode.optional(),
    causeParams: ServerParams.optional(),
  }),
  z.object({ kind: z.literal("pi"), event: PiEvent }),
  z.object({ kind: z.literal("dialog_open"), dialog: Dialog }),
  z.object({ kind: z.literal("dialog_closed"), id: z.string() }),
  z.object({
    kind: z.literal("notice"),
    level: Notice.shape.level,
    text: Notice.shape.text,
    source: Notice.shape.source,
    code: Notice.shape.code,
    params: Notice.shape.params,
  }),
  z.object({ kind: z.literal("row"), row: TranscriptRow }),
  z.object({ kind: z.literal("entry"), entry: EntryRef }),
  z.object({ kind: z.literal("queue"), queue: QueueView }),
  z.object({
    kind: z.literal("status_bar"),
    key: StatusEntry.shape.key,
    text: StatusEntry.shape.text.nullable(),
  }),
  z.object({ kind: z.literal("widget"), key: Widget.shape.key, widget: Widget.nullable() }),
  z.object({ kind: z.literal("title"), title: z.string().max(UI_LIMITS.title).nullable() }),
  z.object({ kind: z.literal("editor_text"), text: z.string().max(UI_LIMITS.editorText) }),
  z.object({ kind: z.literal("panel"), panel: Panel }),
  z.object({ kind: z.literal("panel_closed"), id: z.string().max(128) }),
  z.object({ kind: z.literal("name"), name: SessionName.nullable() }),
  z.object({ kind: z.literal("activity"), activity: Activity }),
  z.object({ kind: z.literal("policy"), policy: SessionPolicyView }),
  z.object({ kind: z.literal("loadout"), loadout: SessionLoadout }),
  z.object({ kind: z.literal("subagents"), children: z.array(ChildView).max(CHILD_VIEWS) }),
  z.object({ kind: z.literal("cost"), cost: SessionCost }),
]);
export type SessionStreamEvent = z.infer<typeof SessionStreamEvent>;
export type SnapshotEvent = Extract<SessionStreamEvent, { kind: "snapshot" }>;

export const SessionSummary = z.object({
  id: z.string(),
  cwd: z.string(),
  /** Pi's name for the session, cached; null when it has none. */
  name: SessionName.nullable(),
  status: SessionStatus,
  /** The stored tool preset (MC37); absent from an older daemon. */
  toolPreset: ToolPreset.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** The `login` stream (M7 Task 11): a snapshot of what the flow said so far (at most 64 events), then each event. */
export const LOGIN_SNAPSHOT_EVENTS = 64;
export const LoginStreamEvent = z.union([
  z.object({ kind: z.literal("snapshot"), events: z.array(LoginEvent).max(LOGIN_SNAPSHOT_EVENTS) }).strict(),
  LoginEvent,
]);
export type LoginStreamEvent = z.infer<typeof LoginStreamEvent>;
