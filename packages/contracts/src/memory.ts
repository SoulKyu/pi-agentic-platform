import { z } from "zod";
import { AgentId } from "./platform.ts";

/** What the memory views and requests carry at most (M11R146, M11R147): pi-mem0's own limits, as pap spells them. */
export const MEMORY_LIMITS = {
  items: 200,
  journal: 100,
  staged: 200,
  textChars: 4096,
  forgetIds: 50,
  projects: 200,
} as const;

/** A memory's id as pi-mem0 writes it. */
export const MemoryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const MemoryProjectId = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,128}$/)
  .refine((id) => !id.includes(".."), "no parent segments");

/** The scope a request names: the user's, a project of pi-mem0's index, or one of the owner's agents. */
export const MemoryScopeRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z.object({ kind: z.literal("project"), id: MemoryProjectId }).strict(),
  z.object({ kind: z.literal("agent"), id: AgentId }).strict(),
]);
export type MemoryScopeRef = z.infer<typeof MemoryScopeRef>;

/** One memory of a snapshot. `text` is untrusted (an agent may have written it): shown as text only. */
export const MemoryItemView = z
  .object({
    id: MemoryId,
    text: z.string().max(MEMORY_LIMITS.textChars),
    /** pi-mem0 may write an empty stamp. */
    createdAt: z.string().max(64).nullable(),
    /** Who wrote it (`agent`, `pi-web`, ...), as pi-mem0's snapshot says. */
    source: z.string().max(64).nullable(),
  })
  .strict();
export type MemoryItemView = z.infer<typeof MemoryItemView>;

export const MemoryJournalView = z
  .object({
    at: z.string().max(64),
    /** An add and a forget look different. */
    kind: z.enum(["add", "forget"]),
    text: z.string().max(MEMORY_LIMITS.textChars),
    source: z.string().max(64),
  })
  .strict();
export type MemoryJournalView = z.infer<typeof MemoryJournalView>;

/** pi-mem0 is missing (`installed: false`), its watcher answers (`fresh`), stopped answering (`stale`), or never said (`unknown`). */
export const MemoryStatus = z
  .object({
    installed: z.boolean(),
    watcher: z.enum(["fresh", "stale", "unknown"]),
    checkedAt: z.number().int().min(0).nullable(),
    /** pi-mem0's own redacted text of its last failed capture (300 characters at most): untrusted, shown as text. */
    lastCaptureError: z.string().max(300).nullable(),
    lastCaptureAt: z.string().max(64).nullable(),
  })
  .strict();
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const MemoryScopeView = z
  .object({
    scope: MemoryScopeRef,
    /** A project's label or an agent's name; null for the user scope, which the client names by its kind. */
    label: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type MemoryScopeView = z.infer<typeof MemoryScopeView>;

/** A fact an untrusted run staged for the owner. `untrusted` is always true: every view fences `text`. */
export const StagedFactView = z
  .object({
    factId: z.string().uuid(),
    agentId: AgentId,
    text: z.string().max(MEMORY_LIMITS.textChars),
    createdAt: z.string().max(64),
    decision: z.enum(["approved", "rejected"]).nullable(),
    /** pi-mem0 has claimed the decision and is applying the fact. */
    applying: z.boolean(),
    untrusted: z.literal(true),
  })
  .strict();
export type StagedFactView = z.infer<typeof StagedFactView>;
