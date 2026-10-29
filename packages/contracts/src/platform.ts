import { z } from "zod";
import { TrustedHost } from "./policy.ts";
import { ServiceCommand, ServiceFailure, ServiceId, ServiceName, ServicePort } from "./preview-service.ts";
import { isVaultName } from "./vault-names.ts";

/**
 * Who a session is to the daemon (C §2.6): read from the daemon's own records when the worker starts and again at every
 * platform call, never from a parameter. Precedence when several facts hold: child, then agent, then task, then lane.
 */
export const SESSION_TYPES = ["plain", "lane", "task", "agent-thread", "agent-task", "child"] as const;
export const SessionType = z.enum(SESSION_TYPES);
export type SessionType = z.infer<typeof SessionType>;

export interface SessionFacts {
  /** `sessions.parent_session_id`: a subagent's child thread (D11). */
  readonly parentSessionId: string | null;
  /** `sessions.agent_role`: the agent's pinned thread, a run of the agent outside it (trigger, delegation), or the child of its thread. */
  readonly agentRole: "thread" | "task" | "child" | null;
  /** The session runs (or ran and kept) an automation task's closed tool list (M10, `session_policy.tool_allowlist`). */
  readonly automationTask: boolean;
  /** The session's folder is inside one of the owner's lane worktrees (M9 `laneInfoOf`). */
  readonly inLane: boolean;
}

export function sessionTypeOf(facts: SessionFacts): SessionType {
  // A row that says "child" without a parent is still a child: fail closed, never the wider `plain`.
  if (facts.parentSessionId !== null || facts.agentRole === "child") return "child";
  if (facts.agentRole === "thread") return "agent-thread";
  if (facts.agentRole === "task") return "agent-task";
  if (facts.automationTask) return "task";
  if (facts.inLane) return "lane";
  return "plain";
}

/** What a tainted caller gets (C §5.4; owner m4): the op runs, the owner is asked first (Deny / Allow once), or it is refused. */
export const WHEN_TAINTED = ["run", "ask", "refuse"] as const;
export type WhenTainted = (typeof WHEN_TAINTED)[number];

export interface PlatformOpSpec {
  /** The tool name the model sees (registered by pi-host's `pap-platform` inline extension, source `<inline:pap-platform>`). */
  readonly tool: string;
  /** Every session type that may call it. Any other caller is `forbidden` (roadmap M11 exit criterion). */
  readonly callers: readonly SessionType[];
  /** Data can leave the calling session through it (C §5.4): what it starts carries the caller's taint. */
  readonly exfiltration: boolean;
  readonly whenTainted: WhenTainted;
  /** The daemon answers within this; the worker gives up 5 s later (`timeout`). */
  readonly deadlineMs: number;
}

const MINUTE = 60_000;
export const PLATFORM_OPS = {
  "agent.notify": {
    tool: "agent_notify",
    callers: ["agent-thread"],
    exfiltration: false,
    whenTainted: "run",
    deadlineMs: 10_000,
  },
  "agent.approve": {
    tool: "agent_approve",
    callers: ["agent-thread"],
    exfiltration: false,
    whenTainted: "run",
    deadlineMs: 25 * MINUTE,
  },
  "agent.delegate": {
    tool: "agent_delegate",
    callers: ["agent-thread"],
    exfiltration: true,
    whenTainted: "ask",
    deadlineMs: 10_000,
  },
  "agent.remind": {
    tool: "agent_remind",
    callers: ["agent-thread"],
    exfiltration: false,
    whenTainted: "ask",
    deadlineMs: 10_000,
  },
  "lane.note": {
    tool: "lane_note",
    callers: ["lane"],
    exfiltration: false,
    whenTainted: "run",
    deadlineMs: 10_000,
  },
  "secret.request": {
    tool: "secret_request",
    callers: ["agent-thread"],
    exfiltration: false,
    whenTainted: "run",
    deadlineMs: 30 * MINUTE,
  },
  "network.request": {
    tool: "network_request",
    // plain, task and child are a project box's sessions: the daemon refuses the call `forbidden` for any row not in a box.
    callers: ["agent-thread", "plain", "task", "child"],
    exfiltration: false,
    whenTainted: "run",
    deadlineMs: 10_000,
  },
  "subagent.run": {
    tool: "subagent",
    callers: ["plain", "lane", "agent-thread"],
    exfiltration: true,
    whenTainted: "run",
    deadlineMs: 240 * MINUTE,
  },
  "preview.start": {
    tool: "preview_start",
    // plain is a project box's session only: the daemon refuses the call `forbidden` for any row not in a box.
    callers: ["agent-thread", "plain"],
    exfiltration: false,
    whenTainted: "run",
    deadlineMs: 60_000,
  },
  "preview.stop": {
    tool: "preview_stop",
    callers: ["agent-thread", "plain"],
    exfiltration: false,
    whenTainted: "run",
    deadlineMs: 10_000,
  },
} as const satisfies Record<string, PlatformOpSpec>;
export type PlatformOp = keyof typeof PLATFORM_OPS;
export const PLATFORM_OP_NAMES = Object.keys(PLATFORM_OPS) as [PlatformOp, ...PlatformOp[]];
export const PlatformOpName = z.enum(PLATFORM_OP_NAMES);

/** The ops a session of this type may call: what its worker registers at start (pinned; never widened later). */
export const opsFor = (type: SessionType): PlatformOp[] =>
  PLATFORM_OP_NAMES.filter((op) => (PLATFORM_OPS[op].callers as readonly SessionType[]).includes(type));

/** Fixed codes; the worker turns them into fixed sentences (no daemon text reaches the model). */
export const PLATFORM_ERRORS = [
  "forbidden",
  "tainted",
  "bad_request",
  "not_found",
  "refused",
  "limit_reached",
  "rate_limited",
  "paused",
  "budget",
  "sandbox_unavailable",
  "timeout",
  "cancelled",
  "unavailable",
  "internal",
] as const;
export const PlatformError = z.enum(PLATFORM_ERRORS);
export type PlatformError = z.infer<typeof PlatformError>;

export interface CallerFacts {
  readonly type: SessionType;
  readonly tainted: boolean;
  /** The owner answered Allow once for this very tool call (the daemon's own record of the answer, never the worker's word). */
  readonly approvedCall: boolean;
  /** Owner a6 (ii): trusted autonomy on in the profile the worker started with AND in the registry now. Never the worker's word. */
  readonly autonomous?: boolean;
}

/** The daemon's verdict before an op runs: by session type first, then by taint. Pure; the dispatcher calls it at every call. */
export function platformVerdict(op: PlatformOp, caller: CallerFacts): PlatformError | null {
  const spec: PlatformOpSpec = PLATFORM_OPS[op];
  if (!spec.callers.includes(caller.type)) return "forbidden";
  if (!caller.tainted || spec.whenTainted === "run") return null;
  if (spec.whenTainted !== "ask") return "tainted";
  if (caller.approvedCall) return null;
  return caller.autonomous === true && caller.type === "agent-thread" ? null : "tainted";
}

/**
 * `<slug>-<8 hex>`: what the home folder and the vault file are named after. An id made before M14 ends in 4 hex digits (RT-19:
 * a short suffix let two owners' ids meet in the trash); both forms stay valid, and the new one keeps the vault scope name in 48.
 */
export const AgentId = z
  .string()
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,41}[a-z0-9])?-[0-9a-f]{4}|[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?-[0-9a-f]{8})$/,
  );
export type AgentId = z.infer<typeof AgentId>;
/** One word the owner types after `@` (no space): letters first, then letters, digits, `_` or `-`. Unique per owner, any case. */
export const AgentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** A vault entry's name: an environment name that does not hijack the shell or bwrap (`isVaultName`, W5-R17). */
export const VaultName = z.string().refine(isVaultName, "a vault name");
const OneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text), "one line of visible characters");
const Text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // Tab and new line stay; every other control character, format character and separator is refused.
    .refine((text) => !/(?![\t\n])\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/u.test(text), "visible text");

/** Arguments as the model wrote them, parsed by the daemon (never by the worker alone). */
export const PLATFORM_ARGS = {
  "agent.notify": z.object({ text: Text(500) }).strict(),
  "agent.approve": z.object({ title: OneLine(120), summary: Text(1000).optional() }).strict(),
  "agent.delegate": z.object({ agent: AgentName, task: Text(8000) }).strict(),
  "agent.remind": z.object({ when: z.string().min(2).max(64), note: Text(2000) }).strict(),
  // Hidden characters are stripped and the note clipped to 2 000 by the handler, not refused (M11R41); the wire cap is 4x the clip (W5-R20).
  "lane.note": z.object({ note: z.string().max(8000) }).strict(),
  "secret.request": z.object({ name: VaultName, reason: OneLine(500) }).strict(),
  "network.request": z.object({ host: TrustedHost, reason: OneLine(200).optional() }).strict(),
  "subagent.run": z
    .object({
      task: Text(8000),
      profile: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
        .optional(),
    })
    .strict(),
  "preview.start": z.object({ name: ServiceName, command: ServiceCommand, port: ServicePort }).strict(),
  "preview.stop": z.object({ name: ServiceName }).strict(),
} as const satisfies Record<PlatformOp, z.ZodType>;

export const PLATFORM_RESULTS = {
  "agent.notify": z.object({ itemId: Id }).strict(),
  "agent.approve": z.object({ approved: z.boolean() }).strict(),
  "agent.delegate": z.object({ taskId: Id }).strict(),
  "agent.remind": z.object({ taskId: Id, at: z.number().int() }).strict(),
  "lane.note": z.object({}).strict(),
  "secret.request": z
    .object({
      ref: z.string().regex(/^secret-ref:[0-9a-f]{32}$/),
      name: z.string().max(64),
      mode: z.enum(["vault", "once"]),
    })
    .strict(),
  "network.request": z.object({ granted: z.boolean() }).strict(),
  "subagent.run": z
    .object({ childId: Id, answer: z.string().max(51_200), clipped: z.boolean(), tainted: z.boolean() })
    .strict(),
  "preview.start": z
    .object({
      id: ServiceId,
      name: ServiceName,
      port: ServicePort,
      status: z.enum(["running", "failed"]),
      reason: ServiceFailure.nullable(),
    })
    .strict(),
  "preview.stop": z.object({ stopped: z.boolean() }).strict(),
} as const satisfies Record<PlatformOp, z.ZodType>;

/** Worker → daemon. `toolCallId` lets the daemon check its own record of the owner's answer (tainted `ask` ops). */
export const PlatformCallRecord = z
  .object({
    type: z.literal("platform_call"),
    id: Id,
    op: PlatformOpName,
    toolCallId: z.string().min(1).max(256),
    args: z.unknown(),
  })
  .strict();
export type PlatformCallRecord = z.infer<typeof PlatformCallRecord>;
/** Worker → daemon: the tool was stopped (the run's Stop, a deadline): the daemon ends what the op started. */
export const PlatformCancelRecord = z.object({ type: z.literal("platform_cancel"), id: Id }).strict();
/** Daemon → worker. The worker parses `result` again with `PLATFORM_RESULTS[op]`; a mismatch is `internal`. */
export const PlatformResultRecord = z
  .object({
    type: z.literal("platform_result"),
    id: Id,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: PlatformError.optional(),
  })
  .strict()
  .refine(
    (record) =>
      record.ok ? record.error === undefined : record.error !== undefined && record.result === undefined,
    {
      message: "a result or an error",
    },
  );
export type PlatformResultRecord = z.infer<typeof PlatformResultRecord>;

/** The vault's caps, one place: the contract below and the daemon's store both read them. */
export const VAULT_CAPS = { names: 50, valueChars: 4096 } as const;

/** An agent's vault as the worker gets it (M11R8): at most 50 names, each value 1..4096 characters without a NUL. */
export const VaultValue = z
  .string()
  .min(1)
  .max(VAULT_CAPS.valueChars)
  .refine((value) => !value.includes("\0"), "no NUL");
export const VaultValues = z
  .record(VaultName, VaultValue)
  .refine((vault) => Object.keys(vault).length <= VAULT_CAPS.names, "at most 50 names");
/** The daemon's random id of one one-use value, minted at the owner's answer: the only identity of an entry (never its value). */
const OnceId = z.string().min(1).max(64);
/**
 * Values for one use (Task 18): at most three wait in a worker. In a `vault_update` the list is authoritative: the session's
 * full current set, each with the daemon's `expiresAt` (ms); the worker replaces its set and drops a value past it (W5-R37).
 */
export const OnceValues = z
  .array(
    z
      .object({ id: OnceId, name: VaultName, value: VaultValue, expiresAt: z.number().int().nonnegative() })
      .strict(),
  )
  .max(3);

/** Daemon → worker: the vault changed (a secret saved, deleted, or a one-use value waiting). Never sent to a child. */
export const VaultUpdateRecord = z
  .object({ type: z.literal("vault_update"), vault: VaultValues, once: OnceValues })
  .strict();
export type VaultUpdateRecord = z.infer<typeof VaultUpdateRecord>;

/** Worker → daemon: the first sandboxed command that named a one-use secret ran; the worker forgot the value (M11R105). */
export const SecretUsedRecord = z
  .object({ type: z.literal("secret_used"), name: VaultName, id: OnceId })
  .strict();
export type SecretUsedRecord = z.infer<typeof SecretUsedRecord>;

/** `InitRecord.platform`: the tools the worker registers, pinned for its life (`opsFor(type)`, as the daemon decided). */
export const InitPlatform = z
  .object({
    ops: z
      .array(PlatformOpName)
      .max(16)
      .refine((ops) => new Set(ops).size === ops.length, "unique"),
  })
  .strict()
  .default({ ops: [] });
/** `InitRecord.agent`: the agent a session belongs to (its thread, an isolated task, or a child of the thread). */
export const InitAgent = z.object({ id: AgentId, name: AgentName, role: z.string() }).strict();

/**
 * The M11 fields of the init record (M11R8), spread into `InitRecord`. The daemon never logs an init record: `vault` and `once` hold secrets.
 */
export const INIT_PLATFORM_FIELDS = {
  platform: InitPlatform,
  vault: VaultValues.optional(),
  once: OnceValues.optional(),
  agent: InitAgent.optional(),
};
