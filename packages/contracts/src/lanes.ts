import { z } from "zod";
import { FilePath } from "./files.ts";
import { INVISIBLE } from "./policy.ts";
import { ThinkingLevel } from "./session-loadout.ts";

export const LANE_LIMITS = {
  /** Lanes of an owner that are not archived (creating, active, failed): the 65th create is `limit_reached`. */
  activePerOwner: 64,
  /** Creations in flight per owner: the fifth is `capacity`. */
  creatingPerOwner: 4,
  fanout: 4,
  title: 200,
  description: 20_000,
  /** The rendered first prompt a fan-out stores (an issue's fenced text included, M9-RT-14). */
  fanoutPrompt: 24_000,
  branch: 200,
  baseRefs: 500,
  commitPaths: 5000,
  commitMessage: 20_000,
  prTitle: 256,
  prBody: 60_000,
  issueTitle: 256,
  issueBody: 20_000,
  reviewFiles: 2000,
  comments: 500,
  commentBody: 4000,
  excerpt: 500,
  turns: 500,
  turnPreview: 120,
  checkpointsPerLane: 2000,
  /** An untracked file larger than this is left out of checkpoints and named in a lane notice (M9-RT-09). */
  checkpointFileBytes: 50 * 1024 * 1024,
  notices: 8,
  /** The files a restore left untouched, listed to the owner; the total is counted apart. */
  restoreLeft: 50,
  restoreLeftPath: 1024,
  scriptChars: 16_384,
  logChunkBytes: 256 * 1024,
  logTail: 4096,
  summary: 600,
  archivedPage: 100,
} as const;

/** Shared with `lanes-review.ts` and `lane-status.ts` under names no other contract file uses. */
export const LaneCount = z.number().int().nonnegative();
export const LaneTime = z.number().int().min(0).max(8.64e15);
export const laneText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => !text.includes("\0"), "no NUL");
const Count = LaneCount;
const Time = LaneTime;
const Text = laneText;

export const LaneId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?-[0-9a-f]{4}$/);
export const FanoutId = z.string().regex(/^[0-9a-f]{16}$/);
export const Oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const SessionRef = z.string().min(1).max(128);
export const EntryId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * A branch pap creates, names in a refspec or hands to a forge CLI (M9R32). The daemon also runs
 * `git check-ref-format --branch` and requires it to print the name back unchanged (`@` would expand).
 */
export const BRANCH_PATTERN =
  /^(?!(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$)(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock(?:\/|$))(?!.*@)[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9_-])?$/;
export const BranchName = z.string().max(LANE_LIMITS.branch).regex(BRANCH_PATTERN);

/** The slug of a lane id and of its suggested branch: ASCII letters and digits joined by `-`, at most 40, `lane` when empty. */
export function slugOf(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "lane" : slug;
}

/** A base the owner picked from `lanes.preview`: a full local or remote-tracking branch name, or a commit. */
export const BaseRef = z.union([
  z
    .string()
    .max(255)
    .regex(/^refs\/(?:heads|remotes)\/(?!.*\.\.)(?!.*@\{)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  Oid,
]);

export const LaneTitle = z
  .string()
  .trim()
  .min(1)
  .max(LANE_LIMITS.title)
  .refine((title) => !INVISIBLE.test(title), "one line of visible characters");

/** Kinds pap can name; M9 has an adapter for `github` only (M9R107): the others answer "not supported yet". */
export const ForgeKind = z.enum(["github", "gitlab", "gitea"]);
export type ForgeKind = z.infer<typeof ForgeKind>;
export const ScriptKind = z.enum(["setup", "archive", "test"]);
export type ScriptKind = z.infer<typeof ScriptKind>;

export const ModelPick = z.object({
  provider: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  thinking: ThinkingLevel.optional(),
});
export type ModelPick = z.infer<typeof ModelPick>;

export const RemoteView = z.object({ host: z.string().max(255), path: z.string().max(820) });

/**
 * `queued`: approved, waiting for one of the owner's two script slots; `pending`: waiting for the owner's "Run setup"
 * (a lane a token created never runs its setup by itself, M9R110).
 */
export const LaneSetup = z.object({
  state: z.enum(["none", "queued", "pending", "running", "ok", "failed", "interrupted", "unapproved"]),
  exitCode: z.number().int().nullable(),
  startedAt: Time.nullable(),
  finishedAt: Time.nullable(),
});
export const LaneTests = z.object({
  state: z.enum(["none", "queued", "running", "passed", "failed", "interrupted", "unapproved"]),
  exitCode: z.number().int().nullable(),
  finishedAt: Time.nullable(),
});
export const LaneFacts = z.object({
  /** Changed or untracked files in the worktree. */
  dirty: Count.nullable(),
  /** Commits on the lane's branch since its merge base with the base ref (the header's ↑n), and the base's since. */
  ahead: Count.nullable(),
  behind: Count.nullable(),
  /** Commits not on the upstream yet (Push ↑n); null before the first push sets one. */
  unpushed: Count.nullable(),
  additions: Count.nullable(),
  deletions: Count.nullable(),
  checkedAt: Time,
  error: z.enum(["git_missing", "timeout", "failed", "too_large", "git_too_old"]).nullable(),
});
export const PrChecks = z.object({ total: Count, passed: Count, failed: Count, pending: Count });
export const PrView = z.object({
  number: z.number().int().positive(),
  url: z.string().max(2048),
  state: z.enum(["open", "merged", "closed"]).nullable(),
  draft: z.boolean(),
  conflicts: z.boolean().nullable(),
  checks: PrChecks.nullable(),
  checkedAt: Time.nullable(),
  error: z.enum(["forge_missing", "not_signed_in", "not_found", "failed"]).nullable(),
});
export type PrView = z.infer<typeof PrView>;

export const LaneSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("description") }),
  z.object({
    kind: z.literal("issue"),
    forge: ForgeKind,
    url: z.string().max(2048),
    number: z.number().int().positive(),
  }),
]);

/** What the lane tab shows under its header (in memory, the newest 8, gone at a restart). */
export const LaneNotice = z.object({
  kind: z.enum([
    "model_refused",
    "session_failed",
    "checkpoint_before_late",
    "checkpoints_full",
    "large_files_skipped",
    "disk_low",
    "copy_skipped",
    "nested_repo_left_out",
    "auto_test_dropped",
  ]),
  at: Time,
  /** Files left out, entries skipped: the number only (names stay in the setup log or the daemon log). */
  count: Count.nullable(),
});

export const LANE_STATES = ["creating", "active", "archiving", "archived", "failed"] as const;

export const LaneView = z.object({
  id: LaneId,
  projectRoot: FilePath,
  worktree: FilePath,
  title: z.string().max(LANE_LIMITS.title),
  branch: z.string().max(LANE_LIMITS.branch),
  baseRef: z.string().max(255),
  baseLabel: z.string().max(255),
  primarySessionId: SessionRef.nullable(),
  createdBy: z.enum(["session", "token"]),
  state: z.enum(LANE_STATES),
  /** Why a create failed (M9-RT-03, RT-09, RT-23). */
  failedReason: z.enum(["git", "prepare", "disk", "interrupted"]).nullable(),
  setup: LaneSetup,
  tests: LaneTests,
  facts: LaneFacts.nullable(),
  pr: PrView.nullable(),
  forge: ForgeKind.nullable(),
  /** The forge identity (`remote.origin.url` as configured) and where a push would really go (M9-RT-02). */
  remote: RemoteView.nullable(),
  pushRemote: RemoteView.nullable(),
  source: LaneSource,
  model: ModelPick.nullable(),
  fanoutId: FanoutId.nullable(),
  fanoutSlot: z.number().int().min(0).max(3).nullable(),
  firstRunEndedAt: Time.nullable(),
  /** The lane holds `checkpointsPerLane` checkpoints: new ones are refused (never evicted) until it is archived. */
  checkpointsFull: z.boolean(),
  notices: z.array(LaneNotice).max(LANE_LIMITS.notices),
  archivedAt: Time.nullable(),
  createdAt: Time,
});
export type LaneView = z.infer<typeof LaneView>;

export const FanoutView = z.object({
  id: FanoutId,
  prompt: z.string().max(LANE_LIMITS.fanoutPrompt),
  createdAt: Time,
  laneIds: z.array(LaneId).min(1).max(LANE_LIMITS.fanout),
});
export type FanoutView = z.infer<typeof FanoutView>;

export const LaneStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    lanes: z.array(LaneView).max(LANE_LIMITS.activePerOwner),
    fanouts: z.array(FanoutView).max(LANE_LIMITS.activePerOwner),
    archived: Count,
    /** The oldest open lanes were left out to fit the frame (M2R54): the client says so instead of looking complete. */
    truncated: z.boolean(),
  }),
  z.object({ kind: z.literal("lane"), lane: LaneView }),
  z.object({ kind: z.literal("fanout"), fanout: FanoutView }),
]);
export type LaneStreamEvent = z.infer<typeof LaneStreamEvent>;

// ---- preview, scripts, issues ----
export const ScriptView = z.object({
  kind: ScriptKind,
  text: z.string().max(LANE_LIMITS.scriptChars),
  sha256: Sha256,
  approved: z.boolean(),
  /** The text the owner approved last for this project and kind, when it differs (decision 30: "changed since"). */
  previous: z.string().max(LANE_LIMITS.scriptChars).nullable(),
});
export const CONFIG_FIELDS = [
  "setup",
  "archive",
  "test",
  "copy",
  "link",
  "branchPrefix",
  "waitForSetup",
  "forge",
] as const;
export const ProjectConfigView = z.object({
  found: z.boolean(),
  error: z.enum(["too_large", "invalid_yaml", "not_a_map", "unreadable"]).nullable(),
  warnings: z.array(z.enum(CONFIG_FIELDS)).max(CONFIG_FIELDS.length),
  branchPrefix: z.string().max(64),
  waitForSetup: z.boolean(),
  copy: z.array(z.string().max(1024)).max(100),
  link: z.array(z.string().max(1024)).max(100),
  scripts: z.array(ScriptView).max(3),
});
export const BaseRefView = z.object({
  ref: z.string().max(255),
  label: z.string().max(255),
  oid: Oid,
  at: Time.nullable(),
  /** The commit is the main checkout's HEAD or an ancestor of it (the daemon's lineage test); false: not the owner's own line yet. */
  inLineage: z.boolean(),
});
export const LanePreview = z.object({
  /** The folder is the top level of a repository's main checkout. */
  repo: z.boolean(),
  current: z.string().max(255).nullable(),
  refs: z.array(BaseRefView).max(LANE_LIMITS.baseRefs),
  config: ProjectConfigView,
  remote: RemoteView.nullable(),
  forge: ForgeKind.nullable(),
});
export type LanePreview = z.infer<typeof LanePreview>;

/** An issue as the forge CLI gave it: external content, fenced in the prompt and shown as plain text (M9R82). */
export const IssueView = z.object({
  forge: ForgeKind,
  url: z.string().max(2048),
  number: z.number().int().positive(),
  title: Text(LANE_LIMITS.issueTitle),
  body: Text(LANE_LIMITS.issueBody),
  state: z.string().max(32),
  labels: z.array(z.string().max(64)).max(20),
  truncated: z.boolean(),
});
export type IssueView = z.infer<typeof IssueView>;
