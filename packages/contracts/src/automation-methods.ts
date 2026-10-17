import { z } from "zod";

import { TriggerInput } from "./automation.ts";
import { Cursor } from "./frames.ts";
import {
  DryRunResult,
  FirePayload,
  FireView,
  JOURNAL_PAGE,
  ManualFireResult,
  TriggerView,
  WEBHOOK_SECRET_PATTERN,
} from "./automation-views.ts";
import { defineMethod } from "./define.ts";

const TriggerId = z.string().min(1).max(128);
const Secret = z.string().regex(WEBHOOK_SECRET_PATTERN);
const Ok = z.object({ ok: z.literal(true) });

/** The answer of create and update: `secret` is the value shown once, null when the trigger keeps the one it had. */
const WithSecret = z.object({ trigger: TriggerView, secret: Secret.nullable() }).strict();

export const automationTriggerMethods = {
  "automation.triggers.list": defineMethod({
    name: "automation.triggers.list",
    permission: "automation:read",
    idempotent: true,
    params: z.object({ projectId: z.string().min(1).max(128).optional() }).strict(),
    result: z.object({ triggers: z.array(TriggerView).max(200), truncated: z.boolean() }).strict(),
    errors: [],
  }),
  "automation.triggers.get": defineMethod({
    name: "automation.triggers.get",
    permission: "automation:read",
    idempotent: true,
    params: z.object({ triggerId: TriggerId }).strict(),
    result: TriggerView,
    errors: ["not_found"],
  }),
  // The params can hold a credential typed inline in a precheck command: the receipt keeps a hash of no param at all (MC30).
  // A password step-up is required (M10R19). The secret is in this answer only: a replayed commandId answers `conflict`.
  "automation.triggers.create": defineMethod({
    name: "automation.triggers.create",
    permission: "automation:admin",
    idempotent: false,
    secretResult: true,
    sensitiveParams: [],
    params: z.object({ input: TriggerInput }).strict(),
    result: WithSecret,
    errors: ["step_up_required", "limit_reached", "invalid_cwd", "bad_request", "read_only"],
  }),
  "automation.triggers.update": defineMethod({
    name: "automation.triggers.update",
    permission: "automation:admin",
    idempotent: false,
    secretResult: true,
    sensitiveParams: ["triggerId", "baseRevision"],
    params: z
      .object({ triggerId: TriggerId, baseRevision: z.number().int().min(1), input: TriggerInput })
      .strict(),
    result: WithSecret,
    errors: ["step_up_required", "not_found", "conflict", "invalid_cwd", "bad_request", "read_only"],
  }),
  "automation.triggers.delete": defineMethod({
    name: "automation.triggers.delete",
    permission: "automation:admin",
    idempotent: false,
    params: z.object({ triggerId: TriggerId }).strict(),
    result: Ok,
    errors: ["not_found", "read_only"],
  }),
  "automation.triggers.setEnabled": defineMethod({
    name: "automation.triggers.setEnabled",
    permission: "automation:admin",
    idempotent: false,
    params: z.object({ triggerId: TriggerId, enabled: z.boolean() }).strict(),
    result: TriggerView,
    errors: ["not_found", "read_only"],
  }),
  "automation.triggers.rotateSecret": defineMethod({
    name: "automation.triggers.rotateSecret",
    permission: "automation:admin",
    idempotent: false,
    secretResult: true,
    params: z.object({ triggerId: TriggerId }).strict(),
    result: z.object({ secret: Secret }).strict(),
    // bad_request: the trigger is not a webhook trigger, or its config no longer parses.
    errors: ["step_up_required", "not_found", "bad_request", "read_only"],
  }),
};

const TaskId = z.string().min(1).max(128);

/** Tasks (M10R40, M10R41, M10R45). Every mutation is `automation:operate`, which a token may hold: the budget gates its retries. */
export const automationTaskMethods = {
  "automation.tasks.cancel": defineMethod({
    name: "automation.tasks.cancel",
    permission: "automation:operate",
    idempotent: false,
    params: z.object({ taskId: TaskId }).strict(),
    result: z.object({ taskId: TaskId }).strict(),
    // conflict: the task is already over.
    errors: ["not_found", "conflict", "read_only"],
  }),
  "automation.tasks.retry": defineMethod({
    name: "automation.tasks.retry",
    permission: "automation:operate",
    idempotent: false,
    params: z.object({ taskId: TaskId }).strict(),
    result: z.object({ taskId: TaskId }).strict(),
    // conflict: the task is not failed, interrupted or cancelled, or its trigger is gone, disabled or was edited meanwhile.
    errors: [
      "not_found",
      "conflict",
      "automation_paused",
      "budget_reached",
      "rate_limited",
      "read_only",
      "forbidden",
      "bad_request",
    ],
  }),
  // "Use my normal tools" (owner m10a7): lifts the trigger's tool list from a finished task's session. Owner only, with the
  // password step-up; a token never holds `automation:admin`. session_busy: the task still runs, or its worker is busy.
  "automation.tasks.releaseTools": defineMethod({
    name: "automation.tasks.releaseTools",
    permission: "automation:admin",
    idempotent: false,
    // By task while its row exists; by session once the 30-day rule removed the row but the session kept its list.
    params: z.union([
      z.object({ taskId: TaskId }).strict(),
      z.object({ sessionId: z.string().min(1).max(128) }).strict(),
    ]),
    result: z.object({ taskId: TaskId.nullable(), sessionId: z.string().min(1).max(128) }).strict(),
    errors: ["step_up_required", "not_found", "session_busy", "read_only"],
  }),
  // Fires the saved trigger, even a disabled one (M10R63). The payload may hold an alert's text: the receipt hashes the trigger only.
  // A token's fire is budget-gated, a browser session's is not; both count. `rate_limited`: the trigger's queue is full.
  // An agent trigger on the thread takes no payload (`bad_request`, any caller) and no token (`forbidden`, M11R65).
  "automation.fire": defineMethod({
    name: "automation.fire",
    permission: "automation:operate",
    idempotent: false,
    sensitiveParams: ["triggerId"],
    params: z.object({ triggerId: TaskId, payload: FirePayload.optional() }).strict(),
    result: ManualFireResult,
    errors: [
      "not_found",
      "automation_paused",
      "budget_reached",
      "rate_limited",
      "read_only",
      "forbidden",
      "bad_request",
    ],
  }),
  // Nothing is written and no token is spent; a feed is not fetched. A precheck runs only for a browser caller, only when the
  // draft equals the saved trigger in its command, folder and variable names (M10R64).
  "automation.dryRun": defineMethod({
    name: "automation.dryRun",
    permission: "automation:operate",
    idempotent: true,
    params: z
      .object({
        triggerId: TaskId.optional(),
        draft: TriggerInput.optional(),
        payload: FirePayload.optional(),
      })
      .strict()
      .refine(
        (params) => params.triggerId !== undefined || params.draft !== undefined,
        "a trigger or a draft",
      ),
    result: DryRunResult,
    errors: ["not_found", "bad_request"],
  }),
  "automation.journal": defineMethod({
    name: "automation.journal",
    permission: "automation:read",
    idempotent: true,
    params: z.object({ triggerId: TaskId, before: z.number().int().min(1).optional() }).strict(),
    result: z.object({ entries: z.array(FireView).max(JOURNAL_PAGE), hasMore: z.boolean() }).strict(),
    errors: ["not_found"],
  }),
  "automation.failures.dismiss": defineMethod({
    name: "automation.failures.dismiss",
    permission: "automation:operate",
    idempotent: false,
    params: z.object({ effectId: z.number().int().min(1) }).strict(),
    result: Ok,
    errors: ["not_found", "read_only"],
  }),
  "subscribe.tasks": defineMethod({
    name: "subscribe.tasks",
    permission: "automation:read",
    idempotent: true,
    // No key: the stream is the caller's own, like `shell`.
    params: z.object({ after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
};
