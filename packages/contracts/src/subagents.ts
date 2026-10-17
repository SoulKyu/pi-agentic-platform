import { z } from "zod";
import { defineMethod } from "./define.ts";
import { ToolName } from "./policy.ts";

/**
 * What the profile reads hold at most (M11R135). The helper cuts to these; the daemon refuses an answer past them.
 * A list is bounded by `files` per folder, two folders, so 2 * 64 entries: the answer stays far under the helper's record bound.
 */
export const SUBAGENT_LIMITS = {
  /** Agent files read per folder; the next one is skipped and the list says it is cut. */
  files: 64,
  /** A larger file is skipped, not clipped: half a prompt is not a prompt. */
  fileBytes: 32 * 1024,
  list: 128,
  name: 64,
  description: 1024,
} as const;

/** A profile is named by Pi's agent file: the same characters a file name can hold without a path. */
export const SubagentName = z
  .string()
  .min(1)
  .max(SUBAGENT_LIMITS.name)
  .regex(/^[A-Za-z0-9._-]+$/);

/** `user`: `<Pi agent dir>/agents`; `project`: `<project>/.pi/agents`, read only while Pi trusts the project. */
export const SubagentProfile = z
  .object({
    name: SubagentName,
    description: z.string().max(SUBAGENT_LIMITS.description),
    source: z.enum(["user", "project"]),
  })
  .strict();
export type SubagentProfile = z.infer<typeof SubagentProfile>;

/**
 * Files the helper looked at and did not list, by reason: `parse` (front matter that does not parse, a name or description
 * that is missing, invalid or empty once cleaned), `refused` (a link out of the folder, a file that is not a plain file,
 * unreadable), `tooLarge` (over 32 KiB). A `longTerm` profile is left out on purpose and is not counted.
 */
const SkippedCount = z
  .number()
  .int()
  .min(0)
  .max(SUBAGENT_LIMITS.files * 2);
export const SubagentsSkipped = z
  .object({ parse: SkippedCount, refused: SkippedCount, tooLarge: SkippedCount })
  .strict();
export type SubagentsSkipped = z.infer<typeof SubagentsSkipped>;

export const SubagentsProfilesResult = z
  .object({
    profiles: z.array(SubagentProfile).max(SUBAGENT_LIMITS.list),
    truncated: z.boolean(),
    skipped: SubagentsSkipped,
  })
  .strict();
export type SubagentsProfilesResult = z.infer<typeof SubagentsProfilesResult>;

/**
 * The helper's params. The helper is offline by construction (`offline()` wraps the whole read, MC52); this flag changes
 * nothing there. It is informational: the literal makes the daemon say on every call that this is an offline read.
 */
export const SubagentsProfilesHelperParams = z.object({ offline: z.literal(true) }).strict();

/**
 * One profile read whole (29b, carry 1): the helper resolves ONE file by its front-matter name, so a list never carries the prompts.
 * `tools` is the file's `tools` list (null: the file names none, the child keeps its parent's preset); `model` is the file's text,
 * unresolved; `prompt` is the file's body.
 */
export const SubagentsProfileHelperParams = z
  .object({ offline: z.literal(true), name: SubagentName })
  .strict();
export const SubagentProfileFile = SubagentProfile.extend({
  tools: z.array(ToolName).max(32).nullable(),
  model: z.string().min(1).max(128).nullable(),
  prompt: z.string().max(SUBAGENT_LIMITS.fileBytes),
}).strict();
export type SubagentProfileFile = z.infer<typeof SubagentProfileFile>;

/** The states of a `subagent_runs` row (D11, ADR 0053). */
export const SUBAGENT_STATES = ["starting", "running", "done", "failed", "cancelled", "interrupted"] as const;
export const SubagentState = z.enum(SUBAGENT_STATES);
export type SubagentState = z.infer<typeof SubagentState>;

/**
 * What the parent's screen shows of one child, before its open dialogs: the subagents module's half of `ChildView` (streams.ts
 * adds the dialogs, which are the sessions module's, M11R140). `id` is the child's own session id; `costUsd` is the child's.
 */
export const ChildSummary = z
  .object({
    id: z.string().min(1).max(128),
    /** The `subagent_runs` row: what `subagents.cancel` names (M11R153). */
    runId: z.string().min(1).max(128),
    title: z.string().min(1).max(120),
    profile: SubagentName.nullable(),
    state: SubagentState,
    costUsd: z.number().min(0),
  })
  .strict();
export type ChildSummary = z.infer<typeof ChildSummary>;

export const subagentsMethods = {
  // The folder is the session's own (the daemon reads it), never a parameter: no arbitrary path is probed.
  "subagents.profiles": defineMethod({
    name: "subagents.profiles",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ sessionId: z.string().min(1).max(128) }).strict(),
    result: SubagentsProfilesResult,
    errors: ["not_found", "capacity", "timeout", "helper_failed"],
  }),
  // The owner's Stop on one child (M11R153): the run ends `cancelled` with the reason `stopped`.
  "subagents.cancel": defineMethod({
    name: "subagents.cancel",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ runId: z.string().min(1).max(128) }).strict(),
    result: z.object({ ok: z.literal(true) }),
    errors: ["not_found"],
  }),
} as const;
