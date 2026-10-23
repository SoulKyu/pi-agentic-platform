import { z } from "zod";
import { FilePut, HomePut, HomeRemove, SessionResync, VmInit } from "./agents-vm.ts";
import { ImageMime } from "./files.ts";
import { InitChild, InitKnowledge } from "./pi-host-init.ts";
import { AlwaysScope, ApprovalAnswer, ToolName } from "./policy.ts";
import { INIT_PLATFORM_FIELDS, PlatformResultRecord, VaultUpdateRecord } from "./platform.ts";
import { ThinkingLevel, ToolPreset } from "./session-loadout.ts";
import { SessionName } from "./streams.ts";
import { AbsolutePath } from "./text-rules.ts";

// daemon → worker

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
  tools: z
    .object({
      preset: ToolPreset,
      /** An unattended run's closed tool list (M10R28): the worker blocks any other tool by name. */
      allowlist: z.array(ToolName).min(1).max(32).optional(),
    })
    .optional(),
  ...INIT_PLATFORM_FIELDS,
  /** Gone with the host sandbox: a stale daemon sending it refuses the init (the path is named, never the value). */
  sandbox: z.undefined({ error: "the host sandbox is gone: a session's shell is its VM's" }).optional(),
  /** A subagent's child: the profile's prompt, appended to the system prompt once like the agent's (M11R136). */
  child: InitChild.optional(),
  /** The session's OKF bundle (sub-project 5). Missing: no OKF. */
  knowledge: InitKnowledge.optional(),
  policy: z.unknown(),
  /** Tests only: the worker honours it when its environment also has PAP_TEST_PROVIDER=1. */
  testProviderScript: AbsolutePath.optional(),
  /** A worker in an agent's VM (R2, R25, R28): where things are, its relay key and its slot. Never logged. */
  vm: VmInit.optional(),
});
/** What the daemon builds: `platform` may be left out (parsed, it is `{ ops: [] }`: see `ParsedInitRecord`). */
export type InitRecord = z.input<typeof InitRecord>;
export type ParsedInitRecord = z.output<typeof InitRecord>;
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

/** The `error` of a refused `set_model`: the worker does not offer that model (its `listAvailable` rule, ADR 0068). */
export const MODEL_NOT_OFFERED = "pap:model_not_offered";
/** The same refusal when the worker has no such provider at all: an extension's, say, in a run that loads none. */
export const MODEL_PROVIDER_UNKNOWN = "pap:model_provider_unknown";

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
  PlatformResultRecord,
  VaultUpdateRecord,
  SessionResync,
  FilePut,
  HomePut,
  HomeRemove,
]);
export type DaemonToWorker = z.input<typeof DaemonToWorker>;
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

export * from "./pi-host-records.ts";
