import { z } from "zod";

/** What the egress proxy enforces (M11R236). Tests scale a copy down; the daemon never changes these. */
export const EGRESS_LIMITS = {
  connections: 32,
  bytes: 1024 ** 3,
  headBytes: 16 * 1024,
  headMs: 10_000,
  idleMs: 120_000,
  connectionMs: 30 * 60_000,
  commandsPerSession: 8,
  upstream: 256,
  hosts: 64,
  logHosts: 16,
  resolveMs: 5_000,
  connectMs: 10_000,
} as const;

/** Why the proxy refused a target (`x-pap-deny`, M11R238); `limit` also covers a cap tripping. */
export const EGRESS_REASONS = [
  "not_listed",
  "port",
  "ip_literal",
  "bad_target",
  "blocked_ip",
  "dns_failed",
  "bad_request",
  "scheme",
  "limit",
] as const;

export type EgressReason = (typeof EGRESS_REASONS)[number];

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const EgressHost = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(0).max(65_535),
    kind: z.enum(["connect", "http"]),
    verdict: z.enum(["allowed", "refused"]),
    reason: z.enum(EGRESS_REASONS).optional(),
  })
  .strict();
export type EgressHost = z.infer<typeof EgressHost>;

export const EgressReport = z
  .object({
    type: z.literal("egress_report"),
    id: Id,
    hosts: z.array(EgressHost).max(EGRESS_LIMITS.hosts),
    truncated: z.boolean(),
    up: z.number().int().min(0),
    down: z.number().int().min(0),
  })
  .strict();
export type EgressReport = z.infer<typeof EgressReport>;
