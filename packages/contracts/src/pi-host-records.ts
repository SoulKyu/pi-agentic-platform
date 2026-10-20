import { z } from "zod";
import { EgressClose, EgressOpen } from "./egress.ts";
import { FilePutResult, SessionAppend } from "./agents-vm.ts";
import {
  AlwaysScopes,
  ApprovalAnswers,
  GrantKey,
  GuardRule,
  TOOL_CATEGORIES,
  TrustedHost,
} from "./policy.ts";
import { PlatformCallRecord, PlatformCancelRecord, SecretUsedRecord } from "./platform.ts";
import { TaintCauses } from "./taint-cause.ts";

const Id = z.string().min(1).max(128);

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
export const ApprovalRequestRecord = z
  .object({
    type: z.literal("approval_request"),
    id: Id,
    category: z.enum(TOOL_CATEGORIES),
    title: z.string().max(4096),
    message: z.string().max(65_536),
    answers: ApprovalAnswers,
    tool: z.string().min(1).max(256),
    key: GrantKey,
    tainted: z.boolean().default(false),
    taintCauses: TaintCauses.optional(),
    guard: GuardRule.optional(),
    /** What "always" may cover besides the exact call (Task 2a). */
    alwaysScopes: AlwaysScopes.optional(),
    /** The call the question is about: the audit row of its answer names who answered (M4 of the M5 final review). */
    toolCallId: z.string().max(256).optional(),
    /** The host a `host` answer would allow (the `network_request` card); present exactly when `answers` holds `host`. */
    host: TrustedHost.optional(),
  })
  .refine((record) => (record.host !== undefined) === record.answers.includes("host"), {
    message: "a card carries its host exactly when it offers the host answer",
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
  PlatformCallRecord,
  PlatformCancelRecord,
  SecretUsedRecord,
  EgressOpen,
  EgressClose,
  SessionAppend,
  FilePutResult,
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
