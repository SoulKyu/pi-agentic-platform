import { z } from "zod";
import { defineMethod } from "./define.ts";
import { AGENT_GATE_ERRORS } from "./errors.ts";
import { FilePath } from "./files.ts";
import { Cursor } from "./frames.ts";
import {
  BaseRef,
  BranchName,
  FanoutId,
  IssueView,
  LANE_LIMITS,
  LaneId,
  LanePreview,
  LaneTitle,
  LaneView,
  ModelPick,
  Oid,
  PrView,
  RemoteView,
  ScriptKind,
  SessionRef,
  Sha256,
} from "./lanes.ts";
import {
  CheckpointStatus,
  CompareColumn,
  LaneTurn,
  ReviewDoc,
  ReviewList,
  ReviewScope,
} from "./lanes-review.ts";
import { RepoPath } from "./vcs.ts";

const Ok = z.object({ ok: z.literal(true) });
const Lane = z.object({ laneId: LaneId });
/** A refusal the person can act on is an answer, not an error (ADR 0027's pattern): its reason picks the copy. */
const refused = <const R extends readonly [string, ...string[]]>(reasons: R) =>
  z.object({ ok: z.literal(false), reason: z.enum(reasons) });
/**
 * The owner read the inline warning "Runs this lane's files, which an agent that read external content may have
 * changed" (M9-RT-01): without it, a run in a lane with a tainted session answers `tainted`.
 */
const ConfirmTainted = z.boolean().optional();

export const lanesMethods = {
  // ---- read (lanes:read; tokens may hold it) ----
  "subscribe.lane": defineMethod({
    name: "subscribe.lane",
    permission: "lanes:read",
    idempotent: true,
    // No key: the stream is the caller's own lanes (like `shell`).
    params: z.object({ after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
  "lanes.preview": defineMethod({
    name: "lanes.preview",
    permission: "lanes:read",
    idempotent: true,
    params: z.object({ projectRoot: FilePath }),
    result: LanePreview,
    errors: ["not_found", "capacity", "timeout"],
  }),
  "lanes.listArchived": defineMethod({
    name: "lanes.listArchived",
    permission: "lanes:read",
    idempotent: true,
    params: z.object({ before: z.object({ archivedAt: z.number().int(), id: LaneId }).optional() }),
    result: z.object({ lanes: z.array(LaneView).max(LANE_LIMITS.archivedPage), hasMore: z.boolean() }),
    errors: [],
  }),
  "lanes.refresh": defineMethod({
    name: "lanes.refresh",
    permission: "lanes:read",
    idempotent: true,
    params: Lane,
    result: Ok,
    errors: ["not_found", "capacity"],
  }),
  "lanes.scriptLog": defineMethod({
    name: "lanes.scriptLog",
    permission: "lanes:read",
    idempotent: true,
    params: Lane.extend({ kind: ScriptKind, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
    result: z.object({
      text: z.string().max(LANE_LIMITS.logChunkBytes),
      nextOffset: z.number().int().nonnegative().nullable(),
      size: z.number().int().nonnegative(),
      /** The script wrote past the 5 MiB the log keeps. */
      capped: z.boolean(),
    }),
    errors: ["not_found"],
  }),
  "lanes.turns": defineMethod({
    name: "lanes.turns",
    permission: "lanes:read",
    idempotent: true,
    params: Lane.extend({ sessionId: SessionRef }),
    result: z.object({ turns: z.array(LaneTurn).max(LANE_LIMITS.turns), truncated: z.boolean() }),
    errors: ["not_found", "capacity", "timeout"],
  }),
  "lanes.review": defineMethod({
    name: "lanes.review",
    permission: "lanes:read",
    idempotent: true,
    params: Lane.extend({ scope: ReviewScope }),
    result: ReviewList,
    errors: ["not_found", "capacity", "timeout", "read_only", "disk_low"],
  }),
  "lanes.reviewState.get": defineMethod({
    name: "lanes.reviewState.get",
    permission: "lanes:read",
    idempotent: true,
    params: Lane,
    result: z.object({ doc: ReviewDoc, revision: z.number().int().nonnegative() }),
    errors: ["not_found"],
  }),
  "lanes.checkpointStatus": defineMethod({
    name: "lanes.checkpointStatus",
    permission: "lanes:read",
    idempotent: true,
    params: Lane.extend({ sessionId: SessionRef }),
    result: CheckpointStatus,
    errors: ["not_found", "capacity", "timeout", "read_only", "disk_low"],
  }),
  "lanes.compare": defineMethod({
    name: "lanes.compare",
    permission: "lanes:read",
    idempotent: true,
    params: z.object({ fanoutId: FanoutId }),
    result: z.object({ columns: z.array(CompareColumn).max(LANE_LIMITS.fanout) }),
    errors: ["not_found", "capacity", "timeout", "disk_low"],
  }),
  // ---- operate (lanes:operate; tokens may hold it: nothing here runs lane scripts or destroys work; suggestCommit sends the diff to the model provider) ----
  "lanes.create": defineMethod({
    name: "lanes.create",
    permission: "lanes:operate",
    idempotent: false,
    params: z
      .object({
        projectRoot: FilePath,
        title: LaneTitle,
        description: z.string().max(LANE_LIMITS.description),
        branch: BranchName.optional(),
        baseRef: BaseRef.optional(),
        /** One model per lane: two to four make a fan-out group sharing the prompt. `null` is Pi's default model. */
        models: z.array(ModelPick.nullable()).min(1).max(LANE_LIMITS.fanout),
        /** The issue as `lanes.issue` gave it: fenced in the prompt, and the primary session starts tainted (M9R82). */
        issue: IssueView.optional(),
      })
      .refine(
        (create) => create.description.trim().length > 0 || create.issue !== undefined,
        "a description",
      ),
    /** Answered once the rows exist (M9-RT-23): the `lane` stream shows `creating` → `active` or `failed`. */
    result: z.object({
      laneIds: z.array(LaneId).min(1).max(LANE_LIMITS.fanout),
      fanoutId: FanoutId.nullable(),
    }),
    errors: ["not_found", "bad_request", "conflict", "limit_reached", "capacity", "read_only", "disk_low"],
  }),
  "lanes.newSession": defineMethod({
    name: "lanes.newSession",
    permission: "lanes:operate",
    idempotent: false,
    params: Lane,
    result: z.object({ sessionId: SessionRef }),
    errors: ["not_found", "conflict", "capacity", "worker_failed", "read_only", ...AGENT_GATE_ERRORS],
  }),
  "lanes.commit": defineMethod({
    name: "lanes.commit",
    permission: "lanes:operate",
    idempotent: false,
    params: Lane.extend({
      paths: z.array(RepoPath).min(1).max(LANE_LIMITS.commitPaths),
      message: z.string().trim().min(1).max(LANE_LIMITS.commitMessage),
    }),
    result: z.union([
      z.object({ ok: z.literal(true), oid: Oid }),
      refused(["nothing_to_commit", "identity_missing", "conflicted", "failed"]),
    ]),
    errors: ["not_found", "capacity", "timeout", "read_only"],
  }),
  "lanes.suggestCommit": defineMethod({
    name: "lanes.suggestCommit",
    permission: "lanes:operate",
    // A model call costs money: a retry with the same command id gets the receipt, never a second call (M9-RT-24).
    idempotent: false,
    params: Lane.extend({ paths: z.array(RepoPath).min(1).max(LANE_LIMITS.commitPaths) }),
    result: z.union([
      z.object({ ok: z.literal(true), message: z.string().max(LANE_LIMITS.commitMessage) }),
      refused(["nothing", "no_session", "model_failed"]),
    ]),
    errors: [
      "not_found",
      "capacity",
      "timeout",
      "worker_failed",
      "read_only",
      "disk_low",
      ...AGENT_GATE_ERRORS,
    ],
  }),
  "lanes.reviewState.set": defineMethod({
    name: "lanes.reviewState.set",
    permission: "lanes:operate",
    idempotent: false,
    params: Lane.extend({ doc: ReviewDoc, baseRevision: z.number().int().nonnegative() }),
    result: z.object({ revision: z.number().int().positive() }),
    errors: ["not_found", "conflict", "payload_too_large", "read_only"],
  }),
  // ---- admin (lanes:admin; never a token: approves or runs code, sends code out, reaches a forge, destroys work) ----
  "lanes.approveScripts": defineMethod({
    name: "lanes.approveScripts",
    permission: "lanes:admin",
    idempotent: false,
    params: z.object({
      projectRoot: FilePath,
      scripts: z
        .array(z.object({ kind: ScriptKind, sha256: Sha256 }))
        .min(1)
        .max(3),
    }),
    result: z.union([Ok, refused(["changed"])]),
    errors: ["not_found", "step_up_required", "forbidden", "read_only"],
  }),
  "lanes.runScript": defineMethod({
    name: "lanes.runScript",
    permission: "lanes:admin",
    idempotent: false,
    params: Lane.extend({ kind: z.enum(["setup", "test"]), confirmTainted: ConfirmTainted }),
    result: z.union([Ok, refused(["none", "unapproved", "running", "tainted", "not_active"])]),
    errors: ["not_found", "capacity", "read_only"],
  }),
  "lanes.restore": defineMethod({
    name: "lanes.restore",
    permission: "lanes:admin",
    idempotent: false,
    params: z.union([Lane.extend({ sessionId: SessionRef }), Lane.extend({ undo: z.literal(true) })]),
    /** `changed: false`: the files already were the target's; `undo` kept as it was (M9-RT-06). */
    result: z.union([
      z.object({
        ok: z.literal(true),
        changed: z.boolean(),
        /** What the restore left where it was (a file over the size limit, an unreadable or ignored one, a folder in the way): the first few, then the total. */
        left: z
          .array(
            z.object({
              path: z.string().max(LANE_LIMITS.restoreLeftPath),
              reason: z.enum(["large", "unreadable", "ignored", "conflict"]),
            }),
          )
          .max(LANE_LIMITS.restoreLeft)
          .optional(),
        leftTotal: z.number().int().nonnegative().optional(),
      }),
      refused(["busy", "no_checkpoint", "failed"]),
    ]),
    errors: ["not_found", "capacity", "timeout", "disk_low"],
  }),
  "lanes.issue": defineMethod({
    name: "lanes.issue",
    permission: "lanes:admin",
    idempotent: true,
    params: z.object({ projectRoot: FilePath, url: z.string().min(1).max(2048) }),
    result: z.union([
      z.object({ ok: z.literal(true), issue: IssueView }),
      refused(["unsupported_url", "forge_missing", "not_signed_in", "not_found", "failed"]),
    ]),
    errors: ["not_found", "capacity", "timeout"],
  }),
  "lanes.push": defineMethod({
    name: "lanes.push",
    permission: "lanes:admin",
    idempotent: false,
    params: Lane,
    result: z.union([
      z.object({ ok: z.literal(true), remote: RemoteView }),
      refused(["no_remote", "unsupported_remote", "repo_config", "rejected", "auth", "network", "failed"]),
    ]),
    errors: ["not_found", "capacity", "timeout", "read_only"],
  }),
  "lanes.prCreate": defineMethod({
    name: "lanes.prCreate",
    permission: "lanes:admin",
    idempotent: false,
    params: Lane.extend({
      title: z.string().trim().min(1).max(LANE_LIMITS.prTitle),
      body: z.string().max(LANE_LIMITS.prBody),
      draft: z.boolean(),
    }),
    result: z.union([
      z.object({ ok: z.literal(true), pr: PrView }),
      refused(["forge_missing", "not_signed_in", "unsupported_remote", "not_pushed", "failed"]),
    ]),
    errors: ["not_found", "capacity", "timeout", "read_only"],
  }),
  "lanes.prRefresh": defineMethod({
    name: "lanes.prRefresh",
    permission: "lanes:admin",
    idempotent: true,
    params: Lane,
    result: z.object({ pr: PrView.nullable() }),
    errors: ["not_found", "capacity", "timeout"],
  }),
  "lanes.archive": defineMethod({
    name: "lanes.archive",
    permission: "lanes:admin",
    idempotent: false,
    params: Lane.extend({ force: z.boolean(), deleteBranch: z.boolean(), confirmTainted: ConfirmTainted }),
    result: z.union([
      z.object({ ok: z.literal(true), branchDeleted: z.boolean().nullable() }),
      z.object({
        ok: z.literal(false),
        reason: z.enum(["busy", "dirty", "script_failed", "setup_running", "tainted"]),
        logTail: z.string().max(LANE_LIMITS.logTail).nullable(),
      }),
    ]),
    errors: ["not_found", "capacity", "timeout", "read_only"],
  }),
  "lanes.closeLosers": defineMethod({
    name: "lanes.closeLosers",
    permission: "lanes:admin",
    idempotent: false,
    params: z.object({ fanoutId: FanoutId, winner: LaneId, confirmTainted: ConfirmTainted }),
    result: z.object({
      archived: z.array(LaneId).max(LANE_LIMITS.fanout),
      refused: z
        .array(
          z.object({ laneId: LaneId, reason: z.enum(["busy", "script_failed", "setup_running", "tainted"]) }),
        )
        .max(LANE_LIMITS.fanout),
    }),
    errors: ["not_found", "bad_request", "read_only"],
  }),
} as const;

export type LaneMethodName = keyof typeof lanesMethods;
