import { z } from "zod";
import { defineMethod } from "./define.ts";
import { StageVerdict, STAGE_IDS } from "./policy.ts";

export const AUDIT_ACTORS = ["worker", "user", "token", "cli", "system"] as const;
export const AUDIT_KINDS = ["call", "result", "session", "invalid", "auth", "policy", "audit"] as const;

/** The marker row the daemon writes where a session's worker rows were dropped by the rate limit. */
export const AUDIT_RATE_LIMIT_REASON = "audit rows dropped: rate limit";
export const AUDIT_SESSION_ID_MAX = 128;

const SessionId = z.string().min(1).max(AUDIT_SESSION_ID_MAX);

/**
 * One row of the audit trail as the viewer gets it. Every text here comes from a worker, a tool, the model or a
 * client: the viewer shows it as text only (M5R86).
 */
export const AuditView = z.object({
  id: z.number().int().positive(),
  at: z.number().int(),
  actor: z.enum(AUDIT_ACTORS),
  actorId: z.string().max(128).nullable(),
  kind: z.enum(AUDIT_KINDS),
  sessionId: SessionId.nullable(),
  toolCallId: z.string().max(256).nullable(),
  parentToolCallId: z.string().max(256).nullable(),
  tool: z.string().max(256).nullable(),
  category: z.string().max(32).nullable(),
  decision: z.enum(["allow", "block", "approved", "denied", "info"]),
  reason: z.string().max(1024).nullable(),
  stages: z.array(StageVerdict).max(STAGE_IDS.length),
  args: z.string().max(8192).nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditView = z.infer<typeof AuditView>;

export const auditMethods = {
  "audit.list": defineMethod({
    name: "audit.list",
    permission: "audit:read",
    idempotent: true,
    params: z.object({
      sessionId: SessionId.optional(),
      before: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    result: z.object({
      entries: z.array(AuditView).max(200),
      nextBefore: z.number().int().positive().nullable(),
      truncated: z.boolean(),
    }),
    errors: [],
  }),
} as const;
