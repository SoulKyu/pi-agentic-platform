import { z } from "zod";
import { VM_PHASES } from "./agents-vm-methods.ts";
import { InboxItem } from "./inbox.ts";

const Id = z.string().min(1).max(128);
/** Milliseconds since 1970, within what `Date` holds. */
const Millis = z.number().int().min(0).max(8.64e15);
const Count = z.number().int().nonnegative();
const Usd = z.number().min(0);

export const OVERVIEW_LIMITS = { activities: 3, boxes: 600, members: 64 } as const;

/** The daemon computes the word (R1); the web only renders it. */
export const OverviewState = z.enum(["waiting", "failed", "running", "starting", "stopped"]);
export type OverviewState = z.infer<typeof OverviewState>;

export const OverviewRef = z.object({ kind: z.enum(["agent", "project", "host"]), id: Id }).strict();
export type OverviewRef = z.infer<typeof OverviewRef>;

/** `id` is a session id or, for a task, a task id; `stoppable` is true for a running task. */
export const OverviewActivity = z
  .object({
    kind: z.enum(["thread", "session", "task"]),
    id: Id,
    title: z.string().max(320),
    since: Millis.nullable(),
    stoppable: z.boolean(),
  })
  .strict();
export type OverviewActivity = z.infer<typeof OverviewActivity>;

/** An Inbox item to handle, or a session dialog that has no Inbox item (R4). */
export const OverviewAsk = z.discriminatedUnion("source", [
  z.object({ source: z.literal("inbox"), item: InboxItem }).strict(),
  z.object({ source: z.literal("session"), sessionId: Id, title: z.string().max(320) }).strict(),
]);
export type OverviewAsk = z.infer<typeof OverviewAsk>;

/** `phase` is null and `needMb` is 0 for a host project; `busy`: something runs, so STOP asks first. */
export const OverviewBox = z
  .object({
    ref: OverviewRef,
    name: z.string().max(320),
    state: OverviewState,
    phase: z.enum(VM_PHASES).nullable(),
    activities: z.array(OverviewActivity).max(OVERVIEW_LIMITS.activities),
    more: Count,
    ask: OverviewAsk.nullable(),
    costUsd: Usd,
    apiEquivalent: z.boolean(),
    reservedMb: Count,
    needMb: Count,
    fits: z.boolean(),
    busy: z.boolean(),
    alwaysOn: z.boolean(),
    nextRun: z
      .object({ at: Millis, name: z.string().max(320) })
      .strict()
      .nullable(),
  })
  .strict();
export type OverviewBox = z.infer<typeof OverviewBox>;

/** The capacity discriminator of the owner's view: a contract tag, not a role read (the role comes from the auth port, M14). */
export const OWNER_CAPACITY_ROLE = "owner" as const;

/** `memory` is null when the VM stack is unusable; `failures` is null for a member (Health is `pi:admin`). */
export const OwnerCapacity = z
  .object({
    role: z.literal(OWNER_CAPACITY_ROLE),
    memory: z.object({ usedMb: Count, maxMb: Count, full: z.boolean() }).strict().nullable(),
    workers: z.object({ used: Count, max: Count }).strict(),
    cost: z.object({ totalUsd: Usd, membersUsd: Usd, apiEquivalent: z.boolean() }).strict(),
    failures: Count.nullable(),
  })
  .strict();
export type OwnerCapacity = z.infer<typeof OwnerCapacity>;

export const MemberCapacity = z
  .object({
    role: z.literal("member"),
    sharedPercent: z.number().int().min(0).max(100).nullable(),
    yourMb: Count,
    cost: z.object({ usd: Usd, budgetUsd: Usd.nullable() }).strict(),
  })
  .strict();
export type MemberCapacity = z.infer<typeof MemberCapacity>;

export const OverviewMemberLine = z
  .object({
    userId: Id,
    name: z.string().max(320),
    activeBoxes: Count,
    reservedMb: Count,
    costUsd: Usd,
    budgetUsd: Usd.nullable(),
  })
  .strict();
export type OverviewMemberLine = z.infer<typeof OverviewMemberLine>;

/** `boxes`: active first in urgency order, then stopped by name. `members` is empty for a member. */
export const OverviewSnapshot = z
  .object({
    capacity: z.discriminatedUnion("role", [OwnerCapacity, MemberCapacity]),
    boxes: z.array(OverviewBox).max(OVERVIEW_LIMITS.boxes),
    members: z.array(OverviewMemberLine).max(OVERVIEW_LIMITS.members),
    vmUsable: z.boolean(),
  })
  .strict();
export type OverviewSnapshot = z.infer<typeof OverviewSnapshot>;

/** A tick carries no data (R2): the client reads `overview.get` once per tick. */
export const OverviewStreamEvent = z.object({ kind: z.literal("changed") }).strict();
export type OverviewStreamEvent = z.infer<typeof OverviewStreamEvent>;
