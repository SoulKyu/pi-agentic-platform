import { z } from "zod";
import { ApprovalAnswer, ApprovalAnswers, AuditEntry, GrantKey, TOOL_CATEGORIES } from "./policy.ts";

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
  policy: z.unknown(),
  /** Tests only: the worker honours it when its environment also has PAP_TEST_PROVIDER=1. */
  testProviderScript: AbsolutePath.optional(),
});
export type InitRecord = z.infer<typeof InitRecord>;
const PromptCommand = z.object({
  type: z.literal("prompt"),
  id: z.string(),
  message: z.string(),
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
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
  name: z.string().min(1).max(256),
});
/** The daemon picks the path (under `$PAP_HOME/exports`, Task 18): a worker never writes where a client says. */
const ExportHtmlCommand = z.object({
  type: z.literal("export_html"),
  id: z.string(),
  outputPath: AbsolutePath,
});
const AutoNameCommand = z.object({ type: z.literal("auto_name"), id: z.string() });
const CustomInputRecord = z.object({ type: z.literal("custom_input"), id: Id, data: z.string().max(4096) });
const CustomCancelRecord = z.object({ type: z.literal("custom_cancel"), id: Id });
/**
 * `cancelled`: the daemon could not show the question (limits, malformed). pap-policy treats it as a closed
 * question (fail closed, audit "dialog closed"), never as the user's refusal (M2-RT-22).
 */
const ApprovalResponseRecord = z.object({
  type: z.literal("approval_response"),
  id: Id,
  answer: ApprovalAnswer,
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
  | z.infer<typeof AutoNameCommand>;
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
const AuditRecord = z.object({ type: z.literal("audit"), entry: AuditEntry });
const HealthRecord = z.object({ type: z.literal("health"), rssMb: z.number().nonnegative() });
const ExtensionErrorRecord = z.object({
  type: z.literal("extension_error"),
  extensionPath: z.string(),
  event: z.string(),
  error: z.string(),
});
const PapRecord = z.discriminatedUnion("type", [
  ReadyRecord,
  ResponseRecord,
  UiRequestRecord,
  UiClosedRecord,
  AuditRecord,
  HealthRecord,
  ExtensionErrorRecord,
  CustomRenderRecord,
  CustomCloseRecord,
  ApprovalRequestRecord,
]);
const PiEventRecord = z.looseObject({ type: z.string() });
// Derived, so a record added to PapRecord can never be forwarded as a Pi event by mistake.
const PAP_TYPES: ReadonlySet<string> = new Set(PapRecord.options.map((option) => option.shape.type.value));

export type WorkerRecord =
  z.infer<typeof PapRecord> | { type: "pi_event"; event: z.infer<typeof PiEventRecord> };

export function parseWorkerRecord(raw: unknown): WorkerRecord | null {
  const base = PiEventRecord.safeParse(raw);
  if (!base.success) return null;
  if (PAP_TYPES.has(base.data.type)) {
    const parsed = PapRecord.safeParse(raw);
    return parsed.success ? parsed.data : null;
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
