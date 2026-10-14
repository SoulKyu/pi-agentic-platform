import { z } from "zod";
import { defineMethod } from "./define.ts";
import { FilePath } from "./files.ts";
import { Cursor } from "./frames.ts";

export const VCS_LIMITS = { files: 2000, diffSideBytes: 400 * 1024, pollMs: 15_000 } as const;

/** A path inside a repository: relative, canonical (M8R23). */
export const RepoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "a path inside the repository",
  );

export const DiffSide = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worktree") }),
  z.object({ kind: z.literal("index") }),
  z.object({ kind: z.literal("head") }),
  z.object({ kind: z.literal("commit"), oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }),
]);
export type DiffSide = z.infer<typeof DiffSide>;

export const VcsFile = z.object({
  path: RepoPath,
  oldPath: RepoPath.nullable(),
  /** An untracked folder git lists as one entry (`normal` untracked mode, M8R46): no diff, no counts. */
  folder: z.boolean(),
  index: z.string().length(1),
  worktree: z.string().length(1),
  kind: z.enum([
    "modified",
    "added",
    "deleted",
    "renamed",
    "copied",
    "typechange",
    "untracked",
    "conflicted",
  ]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});
export type VcsFile = z.infer<typeof VcsFile>;

const Count = z.number().int().nonnegative();
export const VcsStatus = z.object({
  root: FilePath,
  repo: z.boolean(),
  branch: z.string().max(256).nullable(),
  detached: z.boolean(),
  upstream: z.string().max(512).nullable(),
  ahead: Count,
  behind: Count,
  files: z.array(VcsFile).max(VCS_LIMITS.files),
  truncated: z.boolean(),
  additions: Count,
  deletions: Count,
  at: z.number().int().min(0).max(8.64e15),
  error: z.enum(["git_missing", "timeout", "failed", "too_large"]).nullable(),
});
export type VcsStatus = z.infer<typeof VcsStatus>;

export const VcsStreamEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), status: VcsStatus.nullable() }),
  z.object({ kind: z.literal("status"), status: VcsStatus }),
]);
export type VcsStreamEvent = z.infer<typeof VcsStreamEvent>;

const DiffText = z.string().max(VCS_LIMITS.diffSideBytes).nullable();

export const vcsMethods = {
  "subscribe.vcs": defineMethod({
    name: "subscribe.vcs",
    permission: "vcs:read",
    idempotent: true,
    params: z.object({ root: FilePath, after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: ["not_found", "capacity"],
  }),
  "vcs.refresh": defineMethod({
    name: "vcs.refresh",
    permission: "vcs:read",
    idempotent: true,
    params: z.object({ root: FilePath }),
    result: z.object({ ok: z.literal(true) }),
    errors: ["not_found", "capacity"],
  }),
  "vcs.fileDiff": defineMethod({
    name: "vcs.fileDiff",
    permission: "vcs:read",
    idempotent: true,
    params: z.object({
      root: FilePath,
      path: RepoPath,
      oldPath: RepoPath.optional(),
      from: DiffSide,
      to: DiffSide,
    }),
    result: z.object({ before: DiffText, after: DiffText, binary: z.boolean(), truncated: z.boolean() }),
    errors: ["not_found", "capacity", "timeout"],
  }),
} as const;
