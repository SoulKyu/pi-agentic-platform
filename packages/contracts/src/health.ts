import { z } from "zod";

export type HealthKind = "feed" | "sched" | "task" | "outbox" | "agent";
export type HealthSeverity = "err" | "att" | "mut";
export type HealthSource =
  | { readonly kind: "trigger"; readonly id: string; readonly name: string | null }
  | { readonly kind: "task"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string; readonly name: string | null }
  | { readonly kind: "effect"; readonly id: number }
  | null;

/** The closed code table (spec §2.2): severity is a property of the code, never chosen at the emission site. */
export const HEALTH_TABLE = [
  { kind: "feed", code: "feed_address", severity: "err" },
  { kind: "feed", code: "feed_redirects", severity: "err" },
  { kind: "feed", code: "feed_too_large", severity: "err" },
  { kind: "feed", code: "feed_timeout", severity: "err" },
  { kind: "feed", code: "feed_tls", severity: "err" },
  { kind: "feed", code: "feed_network", severity: "err" },
  { kind: "feed", code: "not_a_feed", severity: "err" },
  { kind: "feed", code: "feed_status_<n>", severity: "err" },
  { kind: "sched", code: "scheduler_failed", severity: "err" },
  { kind: "sched", code: "missed", severity: "att" },
  { kind: "sched", code: "precheck_failed", severity: "err" },
  { kind: "task", code: "task_failed", severity: "err" },
  { kind: "task", code: "task_budget", severity: "err" },
  { kind: "task", code: "task_deadline", severity: "err" },
  { kind: "task", code: "task_abort_failed", severity: "err" },
  { kind: "task", code: "task_release_failed", severity: "err" },
  { kind: "task", code: "task_end_failed", severity: "err" },
  { kind: "task", code: "task_orphan_session", severity: "err" },
  { kind: "outbox", code: "outbox_handler_error", severity: "err" },
  { kind: "outbox", code: "outbox_handler_overdue", severity: "att" },
  { kind: "outbox", code: "outbox_unknown_kinds", severity: "mut" },
  { kind: "agent", code: "vm_bundle_stale", severity: "att" },
  { kind: "agent", code: "sandbox_unavailable", severity: "att" },
  { kind: "agent", code: "agent_paused", severity: "att" },
  { kind: "agent", code: "capacity", severity: "att" },
  { kind: "agent", code: "agent_crash_paused", severity: "att" },
] as const satisfies readonly {
  readonly kind: HealthKind;
  readonly code: string;
  readonly severity: HealthSeverity;
}[];

const FEED_STATUS = /^feed_status_\d{3}$/;

export function healthSeverityOf(kind: HealthKind, code: string): HealthSeverity | null {
  for (const row of HEALTH_TABLE)
    if (
      row.kind === kind &&
      (row.code === code || (row.code === "feed_status_<n>" && FEED_STATUS.test(code)))
    )
      return row.severity;
  return null;
}

const HealthSourceSchema = z.union([
  z
    .object({
      kind: z.literal("trigger"),
      id: z.string().min(1).max(128),
      name: z.string().max(4096).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("task"), id: z.string().min(1).max(128) }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      id: z.string().min(1).max(128),
      name: z.string().max(4096).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("effect"), id: z.number().int().min(1) }).strict(),
  z.null(),
]);

export const HealthEvent = z
  .object({
    seq: z.number().int().min(1),
    ts: z.number().int().nonnegative(),
    kind: z.enum(["feed", "sched", "task", "outbox", "agent"]),
    severity: z.enum(["err", "att", "mut"]),
    code: z.string().min(1).max(64),
    sourceRef: HealthSourceSchema,
    count: z.number().int().min(1),
  })
  .strict()
  .refine(
    (event) => healthSeverityOf(event.kind, event.code) === event.severity,
    "a known code with its table severity",
  );
export type HealthEvent = z.infer<typeof HealthEvent>;

export const OpsStreamEvent = z.union([
  z
    .object({ kind: z.literal("snapshot"), events: z.array(HealthEvent).max(200), hasMore: z.boolean() })
    .strict(),
  z.object({ kind: z.literal("event"), event: HealthEvent }).strict(),
  z
    .object({
      kind: z.literal("collapse"),
      seq: z.number().int().min(1),
      ts: z.number().int().nonnegative(),
      count: z.number().int().min(1),
    })
    .strict(),
]);
export type OpsStreamEvent = z.infer<typeof OpsStreamEvent>;
export const HEALTH_LIMITS = { buffer: 500, pageDefault: 50, pageMax: 200 } as const;
