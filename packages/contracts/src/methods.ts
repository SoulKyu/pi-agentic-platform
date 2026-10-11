import { z } from "zod";
import { defineMethod, type MethodDef } from "./define.ts";
import { Cursor } from "./frames.ts";
import { MAX_ALWAYS_RULES } from "./policy.ts";
import {
  DialogResponse,
  ForkPoint,
  HistoryMeta,
  SessionSummary,
  TranscriptRow,
  UI_LIMITS,
} from "./streams.ts";

const SessionId = z.string().min(1).max(128);
const Ok = z.object({ ok: z.literal(true) });

const RuleView = z.object({
  id: z.string().min(1).max(128),
  scope: z.string().max(4096),
  tool: z.string().min(1).max(256),
  label: z.string().max(4096),
  createdAt: z.number(),
});

function catalogue<const T extends { readonly [K in keyof T]: MethodDef<K & string> }>(defs: T): T {
  return defs;
}

export const methods = catalogue({
  "system.ping": defineMethod({
    name: "system.ping",
    permission: "system:read",
    idempotent: true,
    params: z.object({}),
    result: z.object({ now: z.number() }),
    errors: [],
  }),
  unsubscribe: defineMethod({
    name: "unsubscribe",
    permission: "system:read",
    idempotent: true,
    params: z.object({ sub: z.string().min(1).max(64) }),
    result: Ok,
    errors: [],
  }),
  "sessions.create": defineMethod({
    name: "sessions.create",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ cwd: z.string().min(1).max(4096) }),
    result: z.object({ sessionId: SessionId }),
    errors: ["invalid_cwd", "capacity", "worker_failed"],
  }),
  "sessions.list": defineMethod({
    name: "sessions.list",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({}),
    result: z.object({ sessions: z.array(SessionSummary) }),
    errors: [],
  }),
  "sessions.prompt": defineMethod({
    name: "sessions.prompt",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({
      sessionId: SessionId,
      text: z.string().min(1).max(200_000),
      streamingBehavior: z.enum(["steer", "followUp"]).optional(),
    }),
    result: z.object({ disposition: z.enum(["started", "queued", "handled"]) }),
    errors: ["not_found", "capacity", "worker_failed", "prompt_rejected", "queue_full", "session_busy"],
  }),
  "sessions.abort": defineMethod({
    name: "sessions.abort",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ sessionId: SessionId }),
    result: Ok,
    errors: ["not_found"],
  }),
  "sessions.clearQueue": defineMethod({
    name: "sessions.clearQueue",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ sessionId: SessionId }),
    result: z.object({
      steering: z.array(z.string().max(200_000)).max(128),
      followUp: z.array(z.string().max(200_000)).max(128),
      /** Texts were left out to stay in the 1 MiB frame (or the worker's answer was unreadable). */
      truncated: z.boolean(),
    }),
    // `timeout`: the worker did not answer in time, so whether the queue was cleared is unknown (R105).
    errors: ["not_found", "worker_failed", "timeout"],
  }),
  "sessions.navigate": defineMethod({
    name: "sessions.navigate",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ sessionId: SessionId, targetId: z.string().min(1).max(128) }),
    result: z.object({
      cancelled: z.boolean(),
      /** The text of the user message navigated to, to edit and send again; fitted to the frame. */
      editorText: z.string().max(UI_LIMITS.editorText).optional(),
    }),
    // No daemon timeout (M2R90): Pi answers when it is done, or the worker is gone (`worker_failed`).
    errors: ["not_found", "session_busy", "capacity", "worker_failed", "command_failed"],
  }),
  "sessions.compact": defineMethod({
    name: "sessions.compact",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ sessionId: SessionId, customInstructions: z.string().max(4096).optional() }),
    result: z.object({
      tokensBefore: z.number().nonnegative(),
      estimatedTokensAfter: z.number().nonnegative().nullable(),
    }),
    // No daemon timeout either: the model writes the summary. Were one added, its `timeout` would mean the outcome is
    // unknown and the call must not be retried (R105).
    errors: ["not_found", "session_busy", "capacity", "worker_failed", "command_failed", "session_empty"],
  }),
  "sessions.respondDialog": defineMethod({
    name: "sessions.respondDialog",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({
      sessionId: SessionId,
      dialogId: z.string().min(1).max(128),
      response: DialogResponse,
    }),
    result: Ok,
    // `bad_request`: an answer the dialog does not offer; the dialog stays open (M2R61).
    errors: ["not_found", "worker_failed", "bad_request"],
  }),
  "sessions.panelInput": defineMethod({
    name: "sessions.panelInput",
    permission: "sessions:operate",
    // Reasoned exception to R65b (owner R2-10): keystrokes are never retried, and a receipt per key would cost an fsync per key.
    idempotent: true,
    params: z.object({
      sessionId: SessionId,
      panelId: z.string().min(1).max(128),
      data: z.string().min(1).max(UI_LIMITS.panelInput),
    }),
    result: Ok,
    errors: ["not_found"],
  }),
  "sessions.history": defineMethod({
    name: "sessions.history",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({
      sessionId: SessionId,
      before: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    result: HistoryMeta.extend({ rows: z.array(TranscriptRow) }),
    errors: ["not_found"],
  }),
  "sessions.toolOutput": defineMethod({
    name: "sessions.toolOutput",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ sessionId: SessionId, toolCallId: z.string().min(1).max(256) }),
    result: z.object({
      text: z.string().max(800_000),
      truncated: z.boolean(),
      isError: z.boolean(),
      args: z
        .string()
        .max(64 * 1024)
        .nullable(),
    }),
    errors: ["not_found"],
  }),
  "sessions.branches": defineMethod({
    name: "sessions.branches",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ sessionId: SessionId }),
    result: z.object({
      leafId: z.string().max(128).nullable(),
      points: z.array(ForkPoint).max(100),
      /** Fork points or choices were left out (the 1 MiB frame, or an entry id the contract cannot carry). */
      truncated: z.boolean(),
    }),
    errors: ["not_found"],
  }),
  "subscribe.session": defineMethod({
    name: "subscribe.session",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ sessionId: SessionId, after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: ["not_found", "capacity"],
  }),
  "policy.listRules": defineMethod({
    name: "policy.listRules",
    permission: "policy:read",
    idempotent: true,
    params: z.object({ cwd: z.string().min(1).max(4096).optional() }),
    result: z.object({
      rules: z.array(RuleView).max(MAX_ALWAYS_RULES),
      /** The oldest rules were left out to stay in the 1 MiB frame. */
      truncated: z.boolean(),
    }),
    errors: [],
  }),
  "policy.revokeRule": defineMethod({
    name: "policy.revokeRule",
    permission: "policy:admin",
    idempotent: false,
    params: z.object({ ruleId: z.string().min(1).max(128) }),
    result: Ok,
    // Another owner's rule is `not_found` too: existence does not leak.
    errors: ["not_found"],
  }),
});
