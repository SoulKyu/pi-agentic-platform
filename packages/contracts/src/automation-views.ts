import { z } from "zod";

import {
  AUTOMATION_LIMITS,
  AUTOMATION_MODES,
  PromptTemplate,
  TriggerExecution,
  TriggerSource,
} from "./automation.ts";
import { ToolName } from "./policy.ts";

/** `pwh_` and 32 random bytes in base64url: the prefix lets a secret scanner recognise a leak (M10R18). */
export const WEBHOOK_SECRET_PATTERN = /^pwh_[A-Za-z0-9_-]{43}$/;

/** `ok`; `unreadable`: the stored config no longer parses (never fires); `no_secret`: a webhook trigger without its key file. */
export const TRIGGER_STATES = ["ok", "unreadable", "no_secret"] as const;

/**
 * What an `automation:read` caller sees (M10R24). `source`, `execution` and `prompt` are as stored, or null when the row
 * is `unreadable`. `redacted` is true for a token caller, whose view has `execution.precheck: null` and `execution.env: []`.
 * The secret is never here: it is shown once, in the answer of create, update or rotateSecret.
 */
export const TriggerView = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(320),
    enabled: z.boolean(),
    state: z.enum(TRIGGER_STATES),
    source: TriggerSource.nullable(),
    execution: TriggerExecution.nullable(),
    prompt: PromptTemplate.nullable(),
    projectId: z.string().min(1).max(128).nullable(),
    cwd: z.string().min(1).max(4096),
    revision: z.number().int().min(1),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    webhookUrl: z.string().max(2048).nullable(),
    secretRotatedAt: z.number().int().nullable(),
    nextFireAt: z.number().int().nullable(),
    lastFireAt: z.number().int().nullable(),
    redacted: z.boolean(),
  })
  .strict();
export type TriggerView = z.infer<typeof TriggerView>;

/** Every state of a task (C §6.1 plus `limited`, the quota state of C §6.4); the last four are terminal and immutable. */
export const TASK_STATES = [
  "queued",
  "running",
  "limited",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export const TaskState = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskState>;
export const TASK_TERMINAL_STATES = ["done", "failed", "cancelled", "interrupted"] as const;

/** What the `tasks` stream carries at most (M10R43): one snapshot never grows with the history. */
export const TASKS_LIMITS = {
  snapshotTasks: 300,
  /** Terminal tasks older than this are left out of the snapshot. */
  windowMs: 86_400_000,
  failures: 20,
  triggers: 200,
  detailChars: 120,
} as const;

/**
 * One row of the board. `detail` is the first line of the payload, clipped and stripped: untrusted text, shown fenced.
 * `needsInput` is a live value (a question waits in the session), `costUsd` counts the open run too.
 */
export const TaskView = z
  .object({
    id: z.string().min(1).max(128),
    triggerId: z.string().min(1).max(128).nullable(),
    triggerName: z.string().max(320),
    projectId: z.string().min(1).max(128).nullable(),
    state: TaskState,
    reason: z.string().max(64).nullable(),
    origin: z.string().min(1).max(32),
    title: z.string().min(1).max(320),
    detail: z.string().max(512).nullable(),
    createdAt: z.number().int(),
    startedAt: z.number().int().nullable(),
    endedAt: z.number().int().nullable(),
    sessionId: z.string().min(1).max(128).nullable(),
    needsInput: z.boolean(),
    costUsd: z.number().min(0),
    resetAt: z.number().int().nullable(),
    /** The task is over and its session no longer carries the trigger's tool list ("Use my normal tools", owner m10a7). */
    toolsReleased: z.boolean(),
  })
  .strict();
export type TaskView = z.infer<typeof TaskView>;

/** A trigger as the board lists it: no config, no secret. */
export const TaskTrigger = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(320),
    enabled: z.boolean(),
    sourceType: z.enum(["schedule", "webhook", "feed", "manual"]),
    projectId: z.string().min(1).max(128).nullable(),
    state: z.enum(TRIGGER_STATES),
    nextFireAt: z.number().int().nullable(),
  })
  .strict();
export type TaskTrigger = z.infer<typeof TaskTrigger>;

/** The numbers over the board; `quietHours` says whether the owner's quiet hours are on now (runs still execute). */
export const TasksCounts = z
  .object({
    paused: z.boolean(),
    slots: z.number().int().min(1).max(8),
    running: z.number().int().min(0),
    queued: z.number().int().min(0),
    quietHours: z.boolean(),
    todayUsd: z.number().min(0),
    budgetUsd: z.number().min(0).nullable(),
  })
  .strict();
export type TasksCounts = z.infer<typeof TasksCounts>;

/** A failed outbox effect the owner has not dismissed. `lastError` is a short code, never provider text. */
export const TaskFailure = z
  .object({
    id: z.number().int().min(1),
    kind: z.string().min(1).max(64),
    lastError: z.string().max(64).nullable(),
    settledAt: z.number().int(),
  })
  .strict();
export type TaskFailure = z.infer<typeof TaskFailure>;

export const TasksStreamEvent = z.discriminatedUnion("kind", [
  TasksCounts.extend({
    kind: z.literal("snapshot"),
    tasks: z.array(TaskView).max(TASKS_LIMITS.snapshotTasks),
    truncated: z.boolean(),
    triggers: z.array(TaskTrigger).max(TASKS_LIMITS.triggers),
    failures: z.array(TaskFailure).max(TASKS_LIMITS.failures),
  }),
  z.object({ kind: z.literal("task"), task: TaskView, previous: TaskState.nullable() }).strict(),
  z.object({ kind: z.literal("trigger"), trigger: TaskTrigger }).strict(),
  z.object({ kind: z.literal("trigger_removed"), id: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("counts"), counts: TasksCounts }).strict(),
  z.object({ kind: z.literal("failure"), failure: TaskFailure }).strict(),
  z.object({ kind: z.literal("failure_dismissed"), id: z.number().int().min(1) }).strict(),
]);
export type TasksStreamEvent = z.infer<typeof TasksStreamEvent>;

/** What a fire became (the `trigger_fires` CHECK): the journal's verdicts. */
export const FIRE_VERDICTS = [
  "fired",
  "dedup",
  "precheck",
  "budget",
  "paused",
  "disabled",
  "throttle",
  "queue_full",
  "unauthorized",
  "too_large",
  "bad_payload",
  "resolved",
  "missed",
  "error",
] as const;
export const FireVerdict = z.enum(FIRE_VERDICTS);
export type FireVerdict = z.infer<typeof FireVerdict>;

/** The sample or manual payload: 64 KiB of UTF-8 at most (M10R63). */
export const FIRE_PAYLOAD_MAX_BYTES = 65_536;
export const FirePayload = z
  .string()
  .max(FIRE_PAYLOAD_MAX_BYTES)
  .refine((text) => new TextEncoder().encode(text).length <= FIRE_PAYLOAD_MAX_BYTES, "at most 64 KiB");

/** A manual fire: the task, or the precheck's skip or an error as an answer. `detail` is a closed code of ours, never outside text. */
export const ManualFireResult = z.union([
  z.object({ verdict: z.literal("fired"), taskId: z.string().min(1).max(128) }).strict(),
  z.object({ verdict: z.enum(["precheck", "error"]), detail: z.string().max(64) }).strict(),
]);
export type ManualFireResult = z.infer<typeof ManualFireResult>;

/** What a precheck did: `pass` fires, `skip` is a non-zero exit, `error` is a timeout or a failure to run. Output is untrusted. */
export const PrecheckOutcome = z
  .object({
    verdict: z.enum(["pass", "skip", "error"]),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().min(0),
    output: z.string().max(AUTOMATION_LIMITS.precheckOutputBytes),
  })
  .strict();
export type PrecheckOutcome = z.infer<typeof PrecheckOutcome>;

/** Why a dry-run would skip: each gate as it stands now, the folder, and the precheck's verdict. */
export const DRY_RUN_REASONS = [
  "paused",
  "budget",
  "queue_full",
  "invalid_cwd",
  "prompt_too_large",
  "precheck",
  "precheck_error",
] as const;

/** M10R64: nothing is written, no session starts, no token is spent and no feed is fetched. */
export const DryRunResult = z
  .object({
    verdict: z.enum(["fire", "skip"]),
    reasons: z.array(z.enum(DRY_RUN_REASONS)).max(DRY_RUN_REASONS.length),
    tools: z.array(ToolName).max(AUTOMATION_LIMITS.tools),
    profile: z
      .object({
        preset: z.enum(["read-only", "full"]),
        mode: z.enum(AUTOMATION_MODES),
        tainted: z.boolean(),
        /** `auto-accept-edits` with `edit` or `write` listed: edits in the folder run without asking. */
        editsUnasked: z.boolean(),
      })
      .strict(),
    cwd: z.string().max(4096),
    /** The exact text, fresh fence ids: untrusted parts are inside `<untrusted>` fences. */
    prompt: z.string().max(131_072),
    precheck: z
      .union([
        PrecheckOutcome,
        z.enum(["not_run_unsaved", "not_run_token", "not_run_paused", "not_run_budget"]),
      ])
      .nullable(),
    budget: z.object({ spentUsd: z.number().min(0), budgetUsd: z.number().min(0).nullable() }).strict(),
    tokens: z.literal("none"),
    feed: z.literal("not_fetched").nullable(),
  })
  .strict();
export type DryRunResult = z.infer<typeof DryRunResult>;

/** One journal line, collapsed repeats counted; the task, its state, its duration and its cost are joined (M10R65). */
export const FireView = z
  .object({
    id: z.number().int().min(1),
    firstAt: z.number().int(),
    at: z.number().int(),
    count: z.number().int().min(1),
    source: z.string().min(1).max(32),
    verdict: FireVerdict,
    detail: z.string().max(512).nullable(),
    taskId: z.string().min(1).max(128).nullable(),
    taskState: TaskState.nullable(),
    durationMs: z.number().int().min(0).nullable(),
    costUsd: z.number().min(0).nullable(),
  })
  .strict();
export type FireView = z.infer<typeof FireView>;
export const JOURNAL_PAGE = 50;
