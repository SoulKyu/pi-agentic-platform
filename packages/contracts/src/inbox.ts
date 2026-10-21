import { z } from "zod";

import { defineMethod } from "./define.ts";
import { Cursor } from "./frames.ts";

/** What the Inbox keeps and sends at most (M10R47, M10R48, M10R49, M10R50). */
export const INBOX_LIMITS = {
  /** The newest items besides the open questions that a snapshot carries. */
  snapshotOthers: 100,
  /** The items of one `inbox.list` page. */
  page: 100,
  markReadIds: 200,
  perOwner: 2000,
  /** A read item whose task is resolved is removed this long after it was created. */
  retentionMs: 30 * 86_400_000,
  /** The most items besides the open questions a client keeps in memory. */
  clientOthers: 300,
} as const;

/** How a question left "To handle": answered by a person, or denied when nobody answered in time (owner m10a3). */
export const INBOX_RESOLUTIONS = ["answered", "timed_out"] as const;

/**
 * Every kind the Inbox names, by group (M11R90). A kind outside these lists comes from a newer daemon: the client shows it
 * as a generic line. The groups are disjoint; the `inbox.list` filters read them (`all` is no group).
 */
export const INBOX_KINDS = {
  toHandle: ["task_needs_input", "agent_approve", "secret_request", "memory_review"],
  replies: ["agent_reply", "delegation_done"],
  tasks: ["task_done", "task_failed", "task_interrupted", "task_limited"],
  info: ["agent_notify", "agent_egress"],
} as const;

export const INBOX_FILTERS = ["all", "to_handle", "replies", "tasks"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** The longest `detail` of an item: one short line an agent or a memory fact wrote (M11R89). */
export const INBOX_DETAIL_CHARS = 500;

/**
 * One line of the Inbox. `kind` is open-ended (M11 adds its own); M10 writes `task_needs_input` (to handle) and
 * `task_done`, `task_failed`, `task_interrupted`, `task_limited` (info); M11's are in `INBOX_KINDS`. `agentId`, `refId`, `entryId` and `detail` are set on agent items
 * (`detail` is untrusted text: shown as text only). `triggerName` is the owner's own text, never a
 * payload; the title shown is built by the client from `kind`. A question that is not resolved is what the badge counts.
 */
export const InboxItem = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.string().min(1).max(32),
    toHandle: z.boolean(),
    taskId: z.string().min(1).max(128).nullable(),
    sessionId: z.string().min(1).max(128).nullable(),
    triggerName: z.string().min(1).max(320),
    costUsd: z.number().min(0).nullable(),
    createdAt: z.number().int(),
    readAt: z.number().int().nullable(),
    resolvedAt: z.number().int().nullable(),
    resolution: z.enum(INBOX_RESOLUTIONS).nullable(),
    agentId: z.string().min(6).max(48).nullable().default(null),
    refId: z.string().min(1).max(128).nullable().default(null),
    entryId: z.string().max(128).nullable().default(null),
    detail: z.string().max(INBOX_DETAIL_CHARS).nullable().default(null),
  })
  .strict();
export type InboxItem = z.infer<typeof InboxItem>;

const Count = z.number().int().min(0);

export const InboxStreamEvent = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("snapshot"),
      items: z.array(InboxItem).max(5000),
      unread: Count,
      toHandle: Count,
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("item"), item: InboxItem }).strict(),
  z.object({ kind: z.literal("counts"), unread: Count, toHandle: Count }).strict(),
]);
export type InboxStreamEvent = z.infer<typeof InboxStreamEvent>;

/** Where `inbox.list` continues: the last item of the page before. */
export const InboxCursor = z.object({ createdAt: z.number().int(), id: z.string().min(1).max(128) }).strict();
export type InboxCursor = z.infer<typeof InboxCursor>;

export const inboxMethods = {
  // A token may mark items read (`inbox:operate`); it never reaches anything else here.
  "inbox.markRead": defineMethod({
    name: "inbox.markRead",
    permission: "inbox:operate",
    idempotent: false,
    params: z
      .object({
        ids: z.array(z.string().min(1).max(128)).max(INBOX_LIMITS.markReadIds).optional(),
        all: z.literal(true).optional(),
      })
      .strict()
      .refine((params) => (params.ids !== undefined) !== (params.all === true), "ids or all, not both"),
    result: z.object({ updated: Count }).strict(),
    errors: ["bad_request", "read_only"],
  }),
  "inbox.list": defineMethod({
    name: "inbox.list",
    permission: "inbox:read",
    idempotent: true,
    params: z.object({ before: InboxCursor.optional(), filter: z.enum(INBOX_FILTERS).optional() }).strict(),
    result: z.object({ items: z.array(InboxItem).max(INBOX_LIMITS.page), hasMore: z.boolean() }).strict(),
    errors: [],
  }),
  "subscribe.inbox": defineMethod({
    name: "subscribe.inbox",
    permission: "inbox:read",
    idempotent: true,
    // No key: the stream is the caller's own, like `shell` and `tasks`.
    params: z.object({ after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
};
