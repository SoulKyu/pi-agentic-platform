import { z } from "zod";
import { TaintCauses } from "./taint-cause.ts";
import {
  AlwaysScopes,
  ApprovalAnswers,
  GuardRule,
  LocalToolRule,
  TOOL_CATEGORIES,
  TrustedHost,
} from "./policy.ts";

/** One open question of a session: an extension's dialog or the policy's approval card. */
export const Dialog = z
  .object({
    id: z.string().min(1).max(128),
    method: z.enum(["select", "confirm", "input", "editor", "approval"]),
    title: z.string().max(4096),
    message: z.string().max(65_536).optional(),
    options: z.array(z.string().max(4096)).max(100).optional(),
    placeholder: z.string().max(4096).optional(),
    prefill: z.string().max(1_000_000).optional(),
    timeout: z.number().int().positive().optional(),
    /** Approval dialogs only (`method: "approval"`): the policy's category and the answers it accepts, in card order. */
    category: z.enum(TOOL_CATEGORIES).optional(),
    answers: ApprovalAnswers.optional(),
    /** Untrusted content reached the session, or the run guard asks: why the card exists (DESIGN §9.2). */
    tainted: z.boolean().optional(),
    /** Approval dialogs only: what tainted the session, newest last (decision 117, A3). */
    taintCauses: TaintCauses.optional(),
    guard: GuardRule.optional(),
    /** Approval dialogs only: the tool the question is about (the scope choice names it, Task 2b). */
    tool: z.string().min(1).max(256).optional(),
    /** Approval dialogs only: what "always" may cover besides the exact call (Task 2a). */
    alwaysScopes: AlwaysScopes.optional(),
    /** Approval dialogs only: the host the `host` answer allows, present exactly when `answers` holds `host` (owner a2). */
    host: TrustedHost.optional(),
    /** Approval dialogs only: the session runs in a VM, which has no host rule to write, so the card offers no "always" (AVM-E18). */
    vm: z.boolean().optional(),
    /** Approval dialogs only: the asked tool is an extension tool of unknown kind, and this rule would declare it local. */
    localTool: LocalToolRule.optional(),
  })
  .superRefine((dialog, ctx) => {
    if ((dialog.host !== undefined) !== (dialog.answers?.includes("host") ?? false)) {
      ctx.addIssue({
        code: "custom",
        message: "a card carries its host exactly when it offers the host answer",
      });
    }
    // An approval without its answers or its category could not be answered by the policy's own rules: refused (M2R61).
    if (dialog.method === "approval" && (!dialog.answers?.length || !dialog.category)) {
      ctx.addIssue({ code: "custom", message: "an approval carries its category and its answers" });
    }
  });
export type Dialog = z.infer<typeof Dialog>;
