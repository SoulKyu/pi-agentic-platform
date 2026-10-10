import { z } from "zod";

export const PolicyRules = z.object({
  profile: z.literal("interactive"),
  approvalMode: z.enum(["auto-accept-edits"]),
});
export type PolicyRules = z.infer<typeof PolicyRules>;

export const TOOL_CATEGORIES = ["read", "edit", "exec", "network", "external-write", "unknown"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const AuditEntry = z.object({
  toolCallId: z.string().max(256),
  tool: z.string().max(256),
  category: z.enum(TOOL_CATEGORIES),
  decision: z.enum(["allow", "block", "approved", "denied"]),
  reason: z.string().max(1024).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// daemon → worker
export const InitRecord = z.object({
  type: z.literal("init"),
  cwd: z.string(),
  agentDir: z.string(),
  sessionFile: z.string().optional(),
  policy: z.unknown(),
  testProviderScript: z.string().optional(),
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

export const DaemonToWorker = z.discriminatedUnion("type", [
  InitRecord,
  PromptCommand,
  AbortCommand,
  GetStateCommand,
  UiResponseRecord,
  ShutdownRecord,
  PolicyUpdateRecord,
]);
export type DaemonToWorker = z.infer<typeof DaemonToWorker>;
type CommandRecord =
  z.infer<typeof PromptCommand> | z.infer<typeof AbortCommand> | z.infer<typeof GetStateCommand>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandInput = DistributiveOmit<CommandRecord, "id">;

// worker → daemon
export const ReadyRecord = z.object({
  type: z.literal("ready"),
  sessionFile: z.string(),
  sessionId: z.string(),
  piVersion: z.string(),
});
export type ReadyRecord = z.infer<typeof ReadyRecord>;
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
]);
const PiEventRecord = z.looseObject({ type: z.string() });
const PAP_TYPES = new Set([
  "ready",
  "response",
  "extension_ui_request",
  "extension_ui_closed",
  "audit",
  "health",
  "extension_error",
]);

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
