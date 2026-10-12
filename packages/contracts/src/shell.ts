import { z } from "zod";
import { defineMethod } from "./define.ts";
import { MAX_PINS } from "./marks.ts";
import { SessionName, SessionStatus } from "./streams.ts";

/** The bounds of the sidebar's data (M4): what one snapshot, page or search answer may carry. */
export const SHELL_LIMITS = {
  /** Sessions in a `shell` snapshot and in the browser's store, besides the pinned ones. */
  sessions: 500,
  pins: MAX_PINS,
  projects: 500,
  /** Code points of a project's display name. */
  projectName: 128,
  /** Code points of a session's preview: the start of its first user message. */
  preview: 120,
  archivedPage: 100,
  searchQuery: 256,
  searchHits: 20,
  /** UTF-16 units of a search snippet, its markers included. */
  snippet: 400,
} as const;

const Id = z.string().min(1).max(128);
/** Milliseconds since 1970, within what `Date` holds (M4R17). */
const Millis = z.number().int().min(0).max(8.64e15);

export const ProjectSummary = z.object({
  id: Id,
  /** The git root of its sessions' folder, or that folder outside git (`policy.scopeOf`, M2R68). */
  root: z.string().min(1).max(4096),
  name: z
    .string()
    .min(1)
    .max(SHELL_LIMITS.projectName * 2),
  /** The person's order: lower first (fractional, so a move rewrites one row). */
  position: z.number().finite(),
  /** Its sessions that are not archived. */
  sessions: z.number().int().nonnegative(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ShellSession = z.object({
  id: Id,
  cwd: z.string().max(4096),
  name: SessionName.nullable(),
  /** The start of the first user message (cleaned like a name); null until there is one. */
  preview: z
    .string()
    .max(SHELL_LIMITS.preview * 2)
    .nullable(),
  status: SessionStatus,
  /** An approval or an extension dialog waits for an answer. */
  needsInput: z.boolean(),
  projectId: Id.nullable(),
  /** 1 for the first pinned session; null when not pinned. */
  pinRank: z.number().int().min(1).max(SHELL_LIMITS.pins).nullable(),
  archivedAt: Millis.nullable(),
  settledAt: Millis.nullable(),
  snoozedUntil: Millis.nullable(),
  createdAt: Millis,
  updatedAt: Millis,
});
export type ShellSession = z.infer<typeof ShellSession>;

export const ProjectChange = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rename"),
    name: z
      .string()
      .min(1)
      .max(SHELL_LIMITS.projectName * 2),
  }),
  z.object({ kind: z.literal("move"), before: Id.nullable() }),
]);
export type ProjectChange = z.infer<typeof ProjectChange>;

export const ShellStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    /**
     * The projects its sessions name, then every other project of the owner with an active session, in the person's
     * order, while there are fewer than `SHELL_LIMITS.projects` (owner Q15, M4R32): 550 at most in all.
     */
    projects: z.array(ProjectSummary).max(SHELL_LIMITS.sessions + SHELL_LIMITS.pins),
    /** Pinned first by rank, then the newest that are not archived. */
    sessions: z.array(ShellSession).max(SHELL_LIMITS.sessions + SHELL_LIMITS.pins),
    /** Sessions not archived that it left out (older than the window, or over the byte budget). */
    more: z.number().int().nonnegative(),
    /** Projects with an active session that it left out (past 500, or over the byte budget). */
    moreProjects: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("session"), session: ShellSession }),
  z.object({ kind: z.literal("project"), project: ProjectSummary }),
  z.object({ kind: z.literal("counts"), archived: z.number().int().nonnegative() }),
]);
export type ShellStreamEvent = z.infer<typeof ShellStreamEvent>;

/** The methods of the sidebar and search, each added by the task that implements it (M4R18). */
export const shellMethods = {
  "projects.update": defineMethod({
    name: "projects.update",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ projectId: Id, change: ProjectChange }),
    // The new state comes over the `shell` stream (M4R24).
    result: z.object({ ok: z.literal(true) }),
    // Another owner's project is `not_found` too (M4R25); `bad_request`: a name that is empty once cleaned.
    errors: ["not_found", "bad_request"],
  }),
} as const;
