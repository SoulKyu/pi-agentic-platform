import { z } from "zod";
import { ImageMime } from "./files.ts";
import {
  AlwaysScope,
  AlwaysScopes,
  ApprovalAnswer,
  ApprovalAnswers,
  GrantKey,
  GuardRule,
  TOOL_CATEGORIES,
} from "./policy.ts";
import { ThinkingLevel, ToolPreset } from "./session-loadout.ts";
import { SessionName } from "./streams.ts";

// daemon → worker
// pap targets Linux, so an absolute path starts with "/". A relative path would be resolved against the
// worker's own working directory, and the policy would then protect the wrong place.
const AbsolutePath = z
  .string()
  .max(4096)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "must be an absolute path");

export const InitRecord = z.object({
  type: z.literal("init"),
  cwd: AbsolutePath,
  agentDir: AbsolutePath,
  /** The pap data directory ($PAP_HOME): the policy protects it like the Pi agent directory. */
  papHome: AbsolutePath,
  /**
   * The umask the daemon was started with, not the 077 it runs under itself: the worker applies it before it opens
   * the Pi session, so the files its tools create in a project get the user's usual modes (R114).
   */
  umask: z.number().int().min(0).max(0o777),
  sessionFile: AbsolutePath.optional(),
  /**
   * pap's id of the session, the name of its folder under `attachments/` (never Pi's own id, which differs). The
   * policy lets the agent read that folder unasked and asks for every other. Missing: every attachment asks.
   */
  papSessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  /**
   * The session's tool preset (M7R76). Missing means `configured`: Pi's own default tools. A value the worker does not
   * know refuses the init, so an unreadable preset never starts a session with more tools than the daemon meant.
   */
  tools: z.object({ preset: ToolPreset }).optional(),
  policy: z.unknown(),
  /** Tests only: the worker honours it when its environment also has PAP_TEST_PROVIDER=1. */
  testProviderScript: AbsolutePath.optional(),
});
export type InitRecord = z.infer<typeof InitRecord>;
/** An image the daemon claimed for a prompt: the worker reads it itself, from pap's pending uploads only (M8R41). */
export const PromptImageRef = z.object({ path: AbsolutePath, mimeType: ImageMime });
export type PromptImageRef = z.infer<typeof PromptImageRef>;
const PromptCommand = z.object({
  type: z.literal("prompt"),
  id: z.string(),
  message: z.string(),
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
  images: z.array(PromptImageRef).max(10).optional(),
});
const AbortCommand = z.object({ type: z.literal("abort"), id: z.string() });
const GetStateCommand = z.object({ type: z.literal("get_state"), id: z.string() });
export const UiResponseRecord = z.object({
  type: z.literal("extension_ui_response"),
  id: z.string(),
  value: z.string().optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.literal(true).optional(),
});
export type UiResponseRecord = z.infer<typeof UiResponseRecord>;
const ShutdownRecord = z.object({ type: z.literal("shutdown"), graceMs: z.number().int().nonnegative() });
const PolicyUpdateRecord = z.object({ type: z.literal("policy_update"), rules: z.unknown() });

/**
 * The `error` of a refused `compact` or `navigate_tree` when Pi is not idle: a typed refusal the daemon maps to
 * `session_busy`, whatever it knew when it sent the command (a run an extension started, a slow hook).
 */
export const WORKER_BUSY = "pap:session_busy";

const Id = z.string().min(1).max(128);
const ClearQueueCommand = z.object({ type: z.literal("clear_queue"), id: z.string() });
const CompactCommand = z.object({
  type: z.literal("compact"),
  id: z.string(),
  customInstructions: z.string().max(4096).optional(),
});
const NavigateTreeCommand = z.object({ type: z.literal("navigate_tree"), id: z.string(), targetId: Id });
const SetSessionNameCommand = z.object({
  type: z.literal("set_session_name"),
  id: z.string(),
  name: SessionName.min(1),
});
/** The daemon picks the path (under `$PAP_HOME/exports`, Task 18): a worker never writes where a client says. */
const ExportHtmlCommand = z.object({
  type: z.literal("export_html"),
  id: z.string(),
  outputPath: AbsolutePath,
});
const AutoNameCommand = z.object({ type: z.literal("auto_name"), id: z.string() });
/** The diff of a lane's selected paths, already clipped by the daemon (200 000 characters). The answer is `{ message }`. */
const SuggestCommitCommand = z.object({
  type: z.literal("suggest_commit"),
  id: z.string(),
  diff: z.string().min(1).max(200_000),
});
const GetAvailableModelsCommand = z.object({ type: z.literal("get_available_models"), id: z.string() });
const GetCommandsCommand = z.object({ type: z.literal("get_commands"), id: z.string() });
/** Session-scoped: the worker never sets Pi's `persist`, so settings.json is not written by a pick (M7R42). */
const SetModelCommand = z.object({
  type: z.literal("set_model"),
  id: z.string(),
  provider: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
});
const SetThinkingLevelCommand = z.object({
  type: z.literal("set_thinking_level"),
  id: z.string(),
  level: ThinkingLevel,
});
/** Applies a preset in place (M7R77): idle only, and never across the `chat` boundary, which restarts the worker. */
const SetToolsCommand = z.object({ type: z.literal("set_tools"), id: z.string(), preset: ToolPreset });
const CustomInputRecord = z.object({ type: z.literal("custom_input"), id: Id, data: z.string().max(4096) });
const CustomCancelRecord = z.object({ type: z.literal("custom_cancel"), id: Id });
/**
 * `cancelled`: the daemon could not show the question (limits, malformed, an id already in use). pap-policy treats it as a closed
 * question (fail closed, audit "dialog closed"), never as the user's refusal (M2-RT-22).
 */
const ApprovalResponseRecord = z.object({
  type: z.literal("approval_response"),
  id: Id,
  answer: ApprovalAnswer,
  /** What an "always" covers; it must be one the card offered (M7R21). */
  scope: AlwaysScope.optional(),
  cancelled: z.literal(true).optional(),
});

export const DaemonToWorker = z.discriminatedUnion("type", [
  InitRecord,
  PromptCommand,
  AbortCommand,
  GetStateCommand,
  ClearQueueCommand,
  CompactCommand,
  NavigateTreeCommand,
  SetSessionNameCommand,
  ExportHtmlCommand,
  AutoNameCommand,
  SuggestCommitCommand,
  GetAvailableModelsCommand,
  GetCommandsCommand,
  SetModelCommand,
  SetThinkingLevelCommand,
  SetToolsCommand,
  UiResponseRecord,
  CustomInputRecord,
  CustomCancelRecord,
  ApprovalResponseRecord,
  ShutdownRecord,
  PolicyUpdateRecord,
]);
export type DaemonToWorker = z.infer<typeof DaemonToWorker>;
type CommandRecord =
  | z.infer<typeof PromptCommand>
  | z.infer<typeof AbortCommand>
  | z.infer<typeof GetStateCommand>
  | z.infer<typeof ClearQueueCommand>
  | z.infer<typeof CompactCommand>
  | z.infer<typeof NavigateTreeCommand>
  | z.infer<typeof SetSessionNameCommand>
  | z.infer<typeof ExportHtmlCommand>
  | z.infer<typeof AutoNameCommand>
  | z.infer<typeof SuggestCommitCommand>
  | z.infer<typeof GetAvailableModelsCommand>
  | z.infer<typeof GetCommandsCommand>
  | z.infer<typeof SetModelCommand>
  | z.infer<typeof SetThinkingLevelCommand>
  | z.infer<typeof SetToolsCommand>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandInput = DistributiveOmit<CommandRecord, "id">;

// worker → daemon
export const ReadyRecord = z.object({
  type: z.literal("ready"),
  sessionFile: z.string(),
  sessionId: z.string(),
  piVersion: z.string(),
  /**
   * Pi's current leaf: where the next entry goes and what the transcript of a hot session shows (Task 10b). Not
   * bounded here: the daemon treats one over 128 characters as unknown (M2-RT-06).
   */
  leafId: z.string().nullable().default(null),
  /** The session's name in Pi; the daemon clips it with `nameOf` (Task 17b). */
  sessionName: z.string().nullable().default(null),
});
export type ReadyRecord = z.infer<typeof ReadyRecord>;
export const CustomRenderRecord = z.object({
  type: z.literal("custom_render"),
  id: Id,
  lines: z.array(z.string()),
});
const CustomCloseRecord = z.object({ type: z.literal("custom_close"), id: Id });
/**
 * The policy's own question (Task 13b). The extension API cannot send it (`ctx.ui` has no approval method); code
 * inside the worker process could, which is R101's residual (ADR 0008).
 */
export const ApprovalRequestRecord = z.object({
  type: z.literal("approval_request"),
  id: Id,
  category: z.enum(TOOL_CATEGORIES),
  title: z.string().max(4096),
  message: z.string().max(65_536),
  answers: ApprovalAnswers,
  tool: z.string().min(1).max(256),
  key: GrantKey,
  tainted: z.boolean().default(false),
  guard: GuardRule.optional(),
  /** What "always" may cover besides the exact call (Task 2a). */
  alwaysScopes: AlwaysScopes.optional(),
  /** The call the question is about: the audit row of its answer names who answered (M4 of the M5 final review). */
  toolCallId: z.string().max(256).optional(),
});
export type ApprovalRequestRecord = z.infer<typeof ApprovalRequestRecord>;
export const ResponseRecord = z.object({
  type: z.literal("response"),
  id: z.string(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ResponseRecord = z.infer<typeof ResponseRecord>;
export const UiRequestRecord = z.looseObject({
  type: z.literal("extension_ui_request"),
  id: z.string(),
  method: z.string(),
});
export type UiRequestRecord = z.infer<typeof UiRequestRecord>;
const UiClosedRecord = z.object({ type: z.literal("extension_ui_closed"), id: z.string() });
/**
 * `entry` travels as unknown: the audit module parses it with `PolicyAuditEntry`, so a malformed one becomes an
 * `invalid` row there instead of vanishing in the parser (M5R113).
 */
const AuditRecord = z.object({ type: z.literal("audit"), entry: z.unknown().optional() });
/**
 * Sent when untrusted content raises the worker's taint, and again at each `agent_end` while it holds (M5R122).
 * `epoch` is the worker's current taint epoch: the daemon ignores a report older than the last clear (M5R60).
 */
export const TaintRecord = z.object({ type: z.literal("taint"), epoch: z.number().int().nonnegative() });
export type TaintRecord = z.infer<typeof TaintRecord>;
/** Where Pi reports the policy's inline extension, and the `extension_error` source the daemon recognises it by. */
export const POLICY_EXTENSION_PATH = "<inline:pap-policy>";
/**
 * Every 30 s. `descendants`: the live processes below the worker that are outside its process group, which are the
 * ones the agent started (M2R107); 0 when an older worker does not say, and off Linux.
 */
const HealthRecord = z.object({
  type: z.literal("health"),
  rssMb: z.number().nonnegative(),
  descendants: z.number().int().nonnegative().default(0),
});
const ExtensionErrorRecord = z.object({
  type: z.literal("extension_error"),
  extensionPath: z.string(),
  event: z.string(),
  error: z.string(),
});
/**
 * Where Pi's leaf is now, when the worker cannot say it with `entry_appended` records: it moved without new entries
 * (a navigation), the newest entry was one Pi announced itself, or more entries are new than one flush sends (`resync`:
 * the daemon's ids for the rows of the run are incomplete until it reads the file after `agent_settled`). Not bounded
 * here: the daemon treats an id over 128 characters as unknown.
 */
export const LeafRecord = z.object({
  type: z.literal("leaf"),
  leafId: z.string().nullable(),
  resync: z.boolean(),
});
export type LeafRecord = z.infer<typeof LeafRecord>;
/**
 * The model, level and tools the session runs with (M7R44). Sent after `ready`, after the model commands and when an
 * extension switches models. The payload travels as unknown: the daemon parses it with `SessionLoadout` and drops an
 * invalid one, so the worker's text is never trusted.
 */
export const LoadoutRecord = z.object({ type: z.literal("loadout"), loadout: z.unknown() });
export type LoadoutRecord = z.infer<typeof LoadoutRecord>;
const PapRecord = z.discriminatedUnion("type", [
  ReadyRecord,
  LeafRecord,
  LoadoutRecord,
  ResponseRecord,
  UiRequestRecord,
  UiClosedRecord,
  AuditRecord,
  HealthRecord,
  TaintRecord,
  ExtensionErrorRecord,
  CustomRenderRecord,
  CustomCloseRecord,
  ApprovalRequestRecord,
]);
const PiEventRecord = z.looseObject({ type: z.string() });
// Derived, so a record added to PapRecord can never be forwarded as a Pi event by mistake.
const PAP_TYPES: ReadonlySet<string> = new Set(PapRecord.options.map((option) => option.shape.type.value));

/**
 * Made by the daemon's parser, never sent by a worker (a worker that sends this type gets a Pi event): an
 * `approval_request` the schema refuses but that has an id to answer, so the policy is told and fails closed.
 */
export interface ApprovalInvalidRecord {
  readonly type: "approval_request_invalid";
  readonly id: string;
  readonly reason: "malformed" | "too_large";
}

export type WorkerRecord =
  | z.infer<typeof PapRecord>
  | ApprovalInvalidRecord
  | { type: "pi_event"; event: z.infer<typeof PiEventRecord> };

const textOver = (value: unknown, max: number): boolean => typeof value === "string" && value.length > max;

function invalidApproval(raw: Record<string, unknown>): ApprovalInvalidRecord | null {
  const id = Id.safeParse(raw.id);
  if (!id.success) return null;
  const tooLarge = textOver(raw.title, 4096) || textOver(raw.message, 65_536);
  return { type: "approval_request_invalid", id: id.data, reason: tooLarge ? "too_large" : "malformed" };
}

export function parseWorkerRecord(raw: unknown): WorkerRecord | null {
  const base = PiEventRecord.safeParse(raw);
  if (!base.success) return null;
  if (PAP_TYPES.has(base.data.type)) {
    const parsed = PapRecord.safeParse(raw);
    if (parsed.success) return parsed.data;
    return base.data.type === "approval_request" ? invalidApproval(base.data) : null;
  }
  return { type: "pi_event", event: base.data };
}

export const GetStateData = z.object({
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number().int().nonnegative(),
  sessionFile: z.string(),
  sessionId: z.string(),
});
export type GetStateData = z.infer<typeof GetStateData>;
