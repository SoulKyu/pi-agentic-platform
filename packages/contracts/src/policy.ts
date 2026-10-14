import { z } from "zod";

export const TOOL_CATEGORIES = ["read", "edit", "exec", "network", "external-write", "unknown"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** The four answers of an approval card (spec C §5.3). */
export const ApprovalAnswer = z.enum(["once", "session", "always", "deny"]);
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;
/** The answers a card offers, in card order: two to four, each at most once (M2-RT-21). */
export const ApprovalAnswers = z
  .array(ApprovalAnswer)
  .min(2)
  .max(4)
  .refine((answers) => new Set(answers).size === answers.length, "each answer at most once");

/** sha256 (lowercase hex) of a tool name, the payload's kind and the call's exact payload, computed by pap-policy (Task 13b). */
export const GrantKey = z.string().regex(/^[0-9a-f]{64}$/);
export const AlwaysRule = z.object({ tool: z.string().min(1).max(256), key: GrantKey });
export type AlwaysRule = z.infer<typeof AlwaysRule>;
export const MAX_ALWAYS_RULES = 1000;

/** A word of a command prefix rule: no blank, quote, `$`, backquote, glob, brace or shell operator (Task 2a). */
export const CommandWord = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:+@/=%,-]+$/);
/** "Always" for every bash call whose every simple command starts with these words (M7R17). */
export const PrefixRule = z.object({ prefix: z.array(CommandWord).min(1).max(4) }).strict();
export type PrefixRule = z.infer<typeof PrefixRule>;
/** "Always" for one tool whatever its input, matched with its registered source (M7R19). */
export const ToolRule = z
  .object({ tool: z.string().min(1).max(256), source: z.enum(["builtin", "mcp"]) })
  .strict();
export type ToolRule = z.infer<typeof ToolRule>;
/** What a card's "always" may cover besides the exact call. */
export const AlwaysScopes = z
  .object({
    prefix: z.array(CommandWord).min(1).max(4).optional(),
    tool: z.literal(true).optional(),
    /** The tool's registered source, with `tool`: the daemon stores it in the rule (Task 2b). */
    toolSource: ToolRule.shape.source.optional(),
  })
  .strict();
export type AlwaysScopes = z.infer<typeof AlwaysScopes>;
export const AlwaysScope = z.enum(["exact", "prefix", "tool"]);
export type AlwaysScope = z.infer<typeof AlwaysScope>;

export const APPROVAL_MODES = ["read-only", "supervised", "auto-accept-edits", "full-access"] as const;
export const ApprovalMode = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof ApprovalMode>;
/** Decision 14: read and edits in the session folder run, the rest asks. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto-accept-edits";

// C0 and C1 controls, line and paragraph separators, bidi and other format characters: a pattern is one visible line.
export const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** A blocked-command pattern the owner writes: a glob over one command segment (`*` any run, `?` one character), Task 4. */
export const DenyPattern = z
  .string()
  .min(1)
  .max(256)
  .refine((pattern) => !INVISIBLE.test(pattern), "a pattern is one line of visible characters");
export const MAX_DENY_PATTERNS = 64;
/** Stable ids of pap's built-in blocked commands (Task 4); a pi-host test keeps this list equal to the checks. */
export const BUILTIN_DENY_IDS = [
  "rm-root",
  "chmod-root",
  "mkfs",
  "dd-device",
  "wipe-device",
  "redirect-device",
  "fork-bomb",
] as const;
/** The largest settings document `policy.setSettings` accepts, in UTF-8 bytes of its JSON. */
export const MAX_SETTINGS_BYTES = 65_536;

/**
 * A host the egress stage lets through (Task 5a): lower-case labels of letters, digits and inner hyphens, at least two
 * labels, or `*.` and such a host (subdomains only). No IP literal, port, path or bare TLD: an IP or `localhost` is
 * refused here because a host list is a list of names; Task 5a refuses IP-literal URLs that no entry names.
 */
const LABEL = "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
export const HostPattern = z
  .string()
  .max(253)
  .regex(new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`))
  .refine((host) => !/^(?:\*\.)?(?:\d+\.)+\d+$/.test(host), "an IP address is not a host name");
export const MAX_ALLOW_HOSTS = 256;

const SHELL_READ_ONLY = [
  "cat",
  "head",
  "tail",
  "nl",
  "stat",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "b2sum",
  "cksum",
  "strings",
  "od",
  "cmp",
  "tac",
  "rev",
  "cut",
  "paste",
  "comm",
  "join",
  "fold",
  "jq",
  "tr",
  "basename",
  "dirname",
  "echo",
  "printf",
  "true",
  "false",
  "pwd",
  "whoami",
  "id",
  "uname",
  "nproc",
  "uptime",
  "free",
  "df",
  "ps",
  "which",
  "wc",
  "file",
  "sort",
  "uniq",
  "diff",
  "date",
  "realpath",
  "readlink",
  "ls",
  "tree",
  "du",
  "find",
  "grep",
  "egrep",
  "fgrep",
  "rg",
];
const GIT_READ_ONLY_SUBCOMMANDS = [
  "status",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "describe",
  "shortlog",
  "merge-base",
  "name-rev",
  "count-objects",
  "check-ignore",
  "show-ref",
  "diff",
  "log",
  "show",
  "blame",
  "grep",
  "cat-file",
  "branch",
  "remote",
  "stash",
  "worktree",
];
/**
 * The commands that run unasked under `readOnlyCommands`, by name, for Settings. The rules live in pi-host
 * (`READ_ONLY_COMMANDS`, `GIT_READ_ONLY`); a pi-host test keeps this list equal to them (M7R125).
 */
export const READ_ONLY_COMMAND_NAMES: readonly string[] = [
  ...SHELL_READ_ONLY,
  ...GIT_READ_ONLY_SUBCOMMANDS.map((sub) => `git ${sub}`),
];

export const GUARD_RULES = ["identical-calls", "tool-calls", "turns"] as const;
export const GuardRule = z.enum(GUARD_RULES);
export type GuardRule = z.infer<typeof GuardRule>;
export const GuardLimits = z.object({
  identicalCalls: z.number().int().min(2).max(100),
  toolCalls: z.number().int().min(1).max(10_000),
  turns: z.number().int().min(1).max(1_000),
});
export type GuardLimits = z.infer<typeof GuardLimits>;
/** Spec C §5.2 stage 04: 5 identical calls, 150 calls, 60 turns per run. */
export const DEFAULT_GUARD: GuardLimits = { identicalCalls: 5, toolCalls: 150, turns: 60 };

/**
 * Whether untrusted content reached the session (stage 07). `epoch` only grows, and only an explicit clear makes it grow
 * (ADR 0020): an update with the same epoch can raise the flag, never lower it (M5R6).
 */
export const TaintState = z.object({ tainted: z.boolean(), epoch: z.number().int().nonnegative() });
export type TaintState = z.infer<typeof TaintState>;
export const NO_TAINT: TaintState = { tainted: false, epoch: 0 };

export const PolicyRules = z
  .object({
    profile: z.literal("interactive"),
    approvalMode: ApprovalMode,
    alwaysAllow: z.array(AlwaysRule).max(MAX_ALWAYS_RULES).default([]),
    alwaysPrefixes: z.array(PrefixRule).max(MAX_ALWAYS_RULES).default([]),
    alwaysTools: z.array(ToolRule).max(MAX_ALWAYS_RULES).default([]),
    /** pap's own catastrophic-command preset (Task 4), on unless the owner turns it off. */
    builtinDenylist: z.boolean().default(true),
    denylist: z.array(DenyPattern).max(MAX_DENY_PATTERNS).default([]),
    /** null: no egress list, the stage is skipped. A list (even empty): only these hosts (Task 5a). */
    allowHosts: z.array(HostPattern).max(MAX_ALLOW_HOSTS).nullable().default(null),
    guard: GuardLimits.default(DEFAULT_GUARD),
    taint: TaintState.default(NO_TAINT),
    /** Read-only shell commands run as reads in supervised and auto-accept-edits (decision 75 Q6, Task 1c). */
    readOnlyCommands: z.boolean().default(true),
    /** The session's tool preset is read-only (P08-6): MCP tools that may change things are blocked (Task 15). */
    readOnlyPreset: z.boolean().default(false),
    /**
     * The coding tools the session's preset leaves active; any other coding tool is blocked by name, whatever reached it
     * (codemode's nested calls, `tool_search`). The worker sets it from its own preset, never from the daemon. null: no pin.
     */
    presetTools: z.array(z.string().min(1).max(64)).max(16).nullable().default(null),
  })
  .strict();
export type PolicyRules = z.infer<typeof PolicyRules>;

/** The owner's policy settings (Task 12a): what every session starts from. */
export const PolicySettings = z
  .object({
    defaultMode: ApprovalMode.default(DEFAULT_APPROVAL_MODE),
    builtinDenylist: z.boolean().default(true),
    denylist: z.array(DenyPattern).max(MAX_DENY_PATTERNS).default([]),
    allowHosts: z.array(HostPattern).max(MAX_ALLOW_HOSTS).nullable().default(null),
    /** Read-only shell commands run as reads in supervised and auto-accept-edits (decision 75 Q6, Task 1c). */
    readOnlyCommands: z.boolean().default(true),
  })
  .strict();
export type PolicySettings = z.infer<typeof PolicySettings>;
export const DEFAULT_POLICY_SETTINGS: PolicySettings = PolicySettings.parse({});

/** What the session header shows: the mode in force, whether the session chose it, and the taint. */
export const SessionPolicyView = z.object({
  mode: ApprovalMode,
  /** True when the session has a mode of its own; false when it follows the owner's default. */
  explicit: z.boolean(),
  tainted: z.boolean(),
  /** The owner's default mode, so the session bar can name what "Use my default" means (M7R123). An older view lacks it. */
  defaultMode: ApprovalMode.default(DEFAULT_APPROVAL_MODE),
});
export type SessionPolicyView = z.infer<typeof SessionPolicyView>;
export const DEFAULT_SESSION_POLICY_VIEW: SessionPolicyView = {
  mode: DEFAULT_APPROVAL_MODE,
  explicit: false,
  tainted: false,
  defaultMode: DEFAULT_APPROVAL_MODE,
};

export const STAGE_IDS = ["00", "01", "02", "03", "04", "05", "06", "07"] as const;
export const StageId = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageId>;
/** One stage's word on a call, a result or a worker start: what it decided and, briefly, why (spec C §5.1). */
export const StageVerdict = z.object({
  stage: StageId,
  outcome: z.enum(["pass", "skip", "allow", "ask", "block", "acted"]),
  reason: z.string().max(256).optional(),
});
export type StageVerdict = z.infer<typeof StageVerdict>;

export const AUDIT_ARGS_MAX = 2048;
const AuditId = z.string().max(256);
const Verdicts = z.array(StageVerdict).max(STAGE_IDS.length);
export const CallAudit = z.object({
  kind: z.literal("call"),
  toolCallId: AuditId,
  parentToolCallId: AuditId.optional(),
  tool: AuditId,
  category: z.enum(TOOL_CATEGORIES),
  decision: z.enum(["allow", "block", "approved", "denied"]),
  reason: z.string().max(1024).optional(),
  /** 01–04 in order; a 06 verdict when markers were restored into the input (Task 8b). */
  stages: Verdicts,
  /** Escaped, redacted and clipped arguments (M5R13), markers never restored here; never a result. */
  args: z.string().max(AUDIT_ARGS_MAX * 2 + 16),
});
export type CallAuditEntry = z.infer<typeof CallAudit>;
/** Sent only when stage 06 or 07 acted on the result (M5R10, owner MQ9). */
export const ResultAudit = z.object({
  kind: z.literal("result"),
  toolCallId: AuditId,
  parentToolCallId: AuditId.optional(),
  tool: AuditId,
  stages: Verdicts,
  redactions: z.number().int().nonnegative().max(1_000_000),
  /** The result came from outside (stage 07): it was fenced and the session is tainted. */
  external: z.boolean(),
});
export const SessionAudit = z.object({
  kind: z.literal("session"),
  stages: Verdicts,
  tools: z.array(z.string().max(256)).max(256),
  toolsTruncated: z.boolean(),
  mode: ApprovalMode,
});
export type SessionAuditEntry = z.infer<typeof SessionAudit>;
export const PolicyAuditEntry = z.discriminatedUnion("kind", [CallAudit, ResultAudit, SessionAudit]);
export type PolicyAuditEntry = z.infer<typeof PolicyAuditEntry>;
