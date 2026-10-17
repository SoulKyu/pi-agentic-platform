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
// An absolute path of a unix socket: at most 107 bytes (sun_path), so at most 107 characters.
const SocketPath = z
  .string()
  .min(2)
  .max(107)
  .regex(/^\/[^\0]+$/);

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

/** Worker to daemon, before the spawn of a networked sandboxed command. */
export const EgressOpen = z.object({ type: z.literal("egress_open"), id: Id }).strict();
/** Worker to daemon, after the command's close. */
export const EgressClose = z.object({ type: z.literal("egress_close"), id: Id }).strict();
export const EgressOpened = z
  .object({
    type: z.literal("egress_opened"),
    id: Id,
    socket: SocketPath.nullable(),
    reason: z.enum(["unavailable", "limit"]).nullable(),
  })
  .strict()
  .refine((record) => (record.socket === null) !== (record.reason === null), "a socket or a reason");
export type EgressOpened = z.infer<typeof EgressOpened>;
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

/** The proxy's last boot or re-check (M11R242): the interpreter of the forwarder and why it cannot run. */
export const EGRESS_STATUS_REASONS = ["no_python", "unsafe_path", "socket_path"] as const;
export const EgressStatus = z
  .object({
    usable: z.boolean(),
    python: z.string().min(1).max(4096).nullable(),
    reason: z.enum(EGRESS_STATUS_REASONS).nullable(),
  })
  .strict();
export type EgressStatus = z.infer<typeof EgressStatus>;
/** What a view from before the proxy existed, and the daemon before its first probe, reads as. */
export const EGRESS_UNKNOWN: EgressStatus = { usable: false, python: null, reason: "no_python" };
