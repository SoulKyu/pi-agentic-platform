import { z } from "zod";

export const TOOL_CATEGORIES = ["read", "edit", "exec", "network", "external-write", "unknown"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** The four answers of an approval card (spec C §5.3). */
export const ApprovalAnswer = z.enum(["once", "session", "always", "deny"]);
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;
/** The answers a card offers, in card order: two to four, each at most once (M2-RT-21). */
export const ApprovalAnswers = z
  .array(ApprovalAnswer)
  .min(2)
  .max(4)
  .refine((answers) => new Set(answers).size === answers.length, "each answer at most once");

/** sha256 (lowercase hex) of a tool name, the payload's kind and the call's exact payload, computed by pap-policy (Task 13b). */
export const GrantKey = z.string().regex(/^[0-9a-f]{64}$/);
export const AlwaysRule = z.object({ tool: z.string().min(1).max(256), key: GrantKey });
export type AlwaysRule = z.infer<typeof AlwaysRule>;
export const MAX_ALWAYS_RULES = 1000;

export const PolicyRules = z.object({
  profile: z.literal("interactive"),
  approvalMode: z.enum(["auto-accept-edits"]),
  /** "Always" answers of this project (Task 14b). Absent in M1 rules, so it defaults to none. */
  alwaysAllow: z.array(AlwaysRule).max(MAX_ALWAYS_RULES).default([]),
});
export type PolicyRules = z.infer<typeof PolicyRules>;

export const AuditEntry = z.object({
  toolCallId: z.string().max(256),
  tool: z.string().max(256),
  category: z.enum(TOOL_CATEGORIES),
  decision: z.enum(["allow", "block", "approved", "denied"]),
  reason: z.string().max(1024).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
