import { z } from "zod";
import { LINE_HIDDEN } from "./text-rules.ts";
import { AgentResources, DEFAULT_AGENT_RESOURCES, PluginPicks, SystemPackages } from "./agents-resources.ts";
import { AgentHostEntry } from "./host-entry.ts";
import { covers } from "./host-covers.ts";
import { ApprovalMode, DenyPattern, MAX_ALLOW_HOSTS, MAX_TRUSTED_SOURCES, TrustedHost } from "./policy.ts";
import { AgentId, AgentName } from "./platform.ts";
import { ThinkingLevel, ToolPreset } from "./session-loadout.ts";

export const AGENT_LIMITS = {
  perOwner: 32,
  nameChars: 32,
  roleChars: 20_000,
  hosts: MAX_ALLOW_HOSTS,
  denyPatterns: 50,
  memoryHintChars: 500,
  trustedSources: MAX_TRUSTED_SOURCES,
} as const;

// Control characters except tab and new line, then format, line and paragraph separators (bidi, zero-width, U+2028/9).
const TEXT_HIDDEN = /(?![\t\n])\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/u;
/** One-line identifiers: the same, tabs and new lines included. */
const visibleLine = (text: string): boolean => !LINE_HIDDEN.test(text);
/** The agent's role: the owner's text appended to its system prompt at each worker start. Tabs and new lines only. */
export const AgentRole = z
  .string()
  .max(AGENT_LIMITS.roleChars)
  .refine((text) => !TEXT_HIDDEN.test(text), "visible text, tabs and new lines only");

/** pi-mem0's memory policy (its README), written into the session's profile entry; trust always wins over it. */
export const AgentMemoryPolicy = z
  .object({
    capture: z.enum(["auto", "off"]).default("auto"),
    save: z.enum(["direct", "staged"]).default("direct"),
    hint: z
      .string()
      .max(AGENT_LIMITS.memoryHintChars)
      .refine((text) => !TEXT_HIDDEN.test(text))
      .optional(),
    recallLimit: z.number().int().min(0).max(20).optional(),
    recallThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();

/**
 * The agent's sandbox (ADR 0048). Owner m7: no folder of the owner's home is ever bound into it in M11; a thread's
 * shell sees the system minus the hidden folders and its home, an isolated task's the system folders, its home
 * read-only and its scratch folder (owner m16, m17).
 */
export const AgentSandbox = z
  .object({
    /** On: the agent's shell runs only inside bwrap, and the agent does not start without a usable bwrap (fail closed). */
    required: z.boolean().default(true),
    /** Network only through pap's egress proxy (ADR 0047); off by default. */
    network: z.boolean().default(false),
  })
  .strict();

/**
 * The agent's own daily budget (owner m14): none by default; the owner sets or clears it in the agent's configuration.
 * M10's shape: 0 refuses every gated run, null is no budget. M10's owner-wide automation budget applies on top.
 */
export const AgentBudget = z
  .object({
    usdPerDay: z.number().min(0).max(1000).nullable().default(null),
    tokensPerDay: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
  })
  .strict();

export const AgentInput = z
  .object({
    name: AgentName,
    /** Two letters or digits on the avatar; derived from the name when absent. */
    initials: z
      .string()
      .regex(/^[A-Z0-9]{1,2}$/)
      .optional(),
    role: AgentRole.default(""),
    model: z
      .object({
        provider: z.string().min(1).max(128).refine(visibleLine, "visible text on one line"),
        modelId: z.string().min(1).max(256).refine(visibleLine, "visible text on one line"),
      })
      .strict()
      .nullable()
      .default(null),
    thinking: ThinkingLevel.nullable().default(null),
    mode: ApprovalMode.default("auto-accept-edits"),
    preset: ToolPreset.default("default"),
    sandbox: AgentSandbox.default({ required: true, network: false }),
    /** null: the owner's own list (Settings › Approvals); a list, even empty: only these hosts for this agent's URL tools. */
    allowHosts: z.array(AgentHostEntry).max(AGENT_LIMITS.hosts).nullable().default(null),
    /** Added to the owner's blocked commands, never instead of them. */
    denylist: z.array(DenyPattern).max(AGENT_LIMITS.denyPatterns).default([]),
    budget: AgentBudget.default({ usdPerDay: null, tokensPerDay: null }),
    /** Other agents may hand it work with `agent_delegate` (opt-in, C §5.4). */
    acceptsDelegation: z.boolean().default(false),
    memory: AgentMemoryPolicy.nullable().default(null),
    /** Owner a6: after external content, its networked shell (behind the egress proxy) and agent_remind / agent_delegate are judged as if untainted (W5-R34). */
    trustedAutonomy: z.boolean().default(false),
    /** Owner a1: hosts the owner controls; reached only over https, they do not taint. Empty by default. */
    trustedSources: z
      .array(TrustedHost)
      .max(AGENT_LIMITS.trustedSources)
      .refine((hosts) => new Set(hosts).size === hosts.length, "each host once")
      .default([]),
    resources: AgentResources.default(DEFAULT_AGENT_RESOURCES),
    systemPackages: SystemPackages.default([]),
    packages: PluginPicks.default(null),
  })
  .strict();
export type AgentInput = z.output<typeof AgentInput>;

/** How far a mode lets the agent act unasked (M11R44): a higher rank is a widening. */
const MODE_RANK: Readonly<Record<ApprovalMode, number>> = {
  "read-only": 0,
  supervised: 1,
  "auto-accept-edits": 2,
  "full-access": 3,
};
/** How many tools a preset hands the agent (M11R44): chat and none hand none, full and configured every one. */
const PRESET_RANK: Readonly<Record<ToolPreset, number>> = {
  none: 0,
  chat: 0,
  "read-only": 1,
  default: 2,
  full: 3,
  configured: 3,
};

/**
 * The changes that let the agent run more, or more widely, later: they take the password step-up (owner c3 of M7/M8,
 * M11R44). A change that only narrows (sandbox back on, network off, a lower mode or preset, fewer hosts, a pattern
 * added) does not; neither does a budget (money, not reach: owner m14).
 */
const autonomyHosts = (input: AgentInput): readonly string[] =>
  input.trustedAutonomy ? (input.allowHosts ?? []) : [];

/**
 * `ownerHosts`: the owner's current list (`null`: no list, which the egress proxy reads as no host, W5-R64 I2; `undefined`:
 * not known, so any own list widens, W5-R36). An agent that goes from the owner's list to its own list widens when that
 * list reaches a host the owner's does not.
 */
export function widensReach(
  before: AgentInput | null,
  after: AgentInput,
  ownerHosts?: readonly string[] | null,
): boolean {
  const was = before ?? AgentInput.parse({ name: after.name });
  const listed = after.allowHosts;
  const hostsWiden =
    was.allowHosts === null
      ? listed !== null &&
        (ownerHosts === undefined
          ? listed.length > 0
          : listed.some((host) => !covers(ownerHosts ?? [], host)))
      : listed === null || listed.some((host) => !covers(was.allowHosts ?? [], host));
  return (
    (was.sandbox.required && !after.sandbox.required) ||
    (!was.sandbox.network && after.sandbox.network) ||
    MODE_RANK[after.mode] > MODE_RANK[was.mode] ||
    PRESET_RANK[after.preset] > PRESET_RANK[was.preset] ||
    hostsWiden ||
    was.denylist.some((pattern) => !after.denylist.includes(pattern)) ||
    (!was.trustedAutonomy && after.trustedAutonomy) ||
    autonomyHosts(after).some((host) => !autonomyHosts(was).includes(host)) ||
    after.trustedSources.some((host) => !was.trustedSources.includes(host))
  );
}

/**
 * What the rail shows of an agent (M11R62), highest first: a waiting agent never looks idle. `quarantined` replaces
 * all of them. An agent whose stored profile no longer parses reads `paused`: it cannot start.
 */
export const AGENT_RAIL_STATES = [
  "needs_input",
  "running",
  "failed",
  "paused",
  "idle",
  "quarantined",
] as const;
export const AgentRailState = z.enum(AGENT_RAIL_STATES);
export type AgentRailState = z.infer<typeof AgentRailState>;

/** The most the `agents` stream carries: an agent per owner is capped at 32, pending requests at 200 (M11R63). */
export const AGENTS_STREAM_LIMITS = { requests: 200 } as const;

/** The avatar's letters: the profile's own, else the first two letters or digits of the name. */
export function agentInitials(name: string, explicit: string | undefined): string {
  if (explicit !== undefined && /^[A-Z0-9]{1,2}$/.test(explicit)) return explicit;
  return (
    name
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/** One agent on the rail. It carries no profile text: no role, no hosts, no budget (M11R63). */
export const AgentSummary = z
  .object({
    id: AgentId,
    name: z.string().min(1).max(AGENT_LIMITS.nameChars),
    initials: z.string().regex(/^[A-Z0-9?]{1,2}$/),
    state: AgentRailState,
    unread: z.number().int().min(0).max(1_000_000),
    paused: z.boolean(),
    quarantined: z.boolean(),
    /** The stored profile does not parse: the agent reads `paused` and cannot start; the rail points to Settings › Agents. */
    unreadable: z.boolean(),
    threadSessionId: z.string().min(1).max(128).nullable(),
    /** The thread's last change, else the agent's last edit. */
    lastActivityAt: z.number().int(),
  })
  .strict();
export type AgentSummary = z.infer<typeof AgentSummary>;

/** What an agent waits for from the owner (`agent.approve`, `secret.request`); the title and detail are the agent's own text. */
export const AgentRequestView = z
  .object({
    id: z.string().min(1).max(64),
    agentId: AgentId,
    kind: z.enum(["approve", "secret"]),
    title: z.string().min(1).max(500),
    detail: z.string().max(1000).nullable(),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();
export type AgentRequestView = z.infer<typeof AgentRequestView>;

/** What the thread's display-only cards carry at most (M11R72); the text of every card but `schedule` and `task` is untrusted. */
export const AGENT_EVENT_LIMITS = {
  page: 100,
  summaryChars: 2_000,
  delegationChars: 16_000,
  noteChars: 2_000,
  notifyChars: 500,
  queuePrompt: 20_000,
} as const;

/** The states a run-shaped card reads: written `running` before the prompt, moved when the task ends. */
export const AGENT_CARD_STATES = ["running", "done", "failed", "cancelled", "interrupted"] as const;
/**
 * Texts pap writes into stored rows (a task title, a card title) in English. The web shows each in the viewer's language
 * by matching the text, so the daemon and the web read the same constants (T12).
 */
export const PAP_TEXT = {
  reminderTitle: "Reminder",
  reminderNotDelivered: "Reminder not delivered: the thread it was set in was reset",
} as const;
const CardTitle = z.string().min(1).max(320);
const CardBilling = z.enum(["api", "subscription", "unknown"]);

/** `schedule` and `task` (a thread task ran): pap's own words, `title` is the trigger's or the owner's. */
export const RunCardData = z
  .object({
    title: CardTitle,
    state: z.enum(AGENT_CARD_STATES),
    durationMs: z.number().int().min(0).nullable().optional(),
    costUsd: z.number().min(0).optional(),
    billing: CardBilling.optional(),
  })
  .strict();
export type RunCardData = z.infer<typeof RunCardData>;

/** `isolated` (an isolated run's summary, M11R69): `scratch` is pap's own text, `summary` the run's. */
export const IsolatedCardData = z
  .object({
    title: CardTitle,
    state: z.enum(["done", "failed"]),
    source: z.string().min(1).max(32),
    tainted: z.boolean(),
    scratch: z.string().min(1).max(4096),
    summary: z.string().max(AGENT_EVENT_LIMITS.summaryChars),
    durationMs: z.number().int().min(0).nullable(),
    costUsd: z.number().min(0),
  })
  .strict();
export type IsolatedCardData = z.infer<typeof IsolatedCardData>;

export const DelegationCardData = z
  .object({
    fromAgentId: AgentId,
    fromName: z.string().min(1).max(AGENT_LIMITS.nameChars),
    state: z.enum(AGENT_CARD_STATES),
    summary: z.string().max(AGENT_EVENT_LIMITS.delegationChars),
    clipped: z.boolean(),
    tainted: z.boolean(),
    isolated: z.boolean(),
  })
  .strict();

export const ReminderCardData = z
  .object({ note: z.string().max(AGENT_EVENT_LIMITS.noteChars), setAt: z.number().int() })
  .strict();

export const NotifyCardData = z
  .object({ text: z.string().min(1).max(AGENT_EVENT_LIMITS.notifyChars), itemId: z.string().min(1).max(128) })
  .strict();
export type NotifyCardData = z.infer<typeof NotifyCardData>;

/**
 * `egress_refused` (sub-project 2): the VM egress proxy refused a host. pap's own facts, no agent text: `host` is the target as
 * the proxy judged it, `address` the private address it resolved to (null otherwise), `source` "thread" or the task key of the
 * task VM, `count` the attempts since `firstAt` (one card per agent and host:port per hour).
 */
export const EgressRefusedCardData = z
  .object({
    host: z.string().min(1).max(260),
    port: z.number().int().min(1).max(65_535),
    reason: z.enum(["not_listed", "private_wildcard", "blocked_address"]),
    address: z.string().min(1).max(64).nullable(),
    source: z.string().min(1).max(128),
    count: z.number().int().min(1),
    firstAt: z.number().int(),
    lastAt: z.number().int(),
  })
  .strict();
export type EgressRefusedCardData = z.infer<typeof EgressRefusedCardData>;

const card = <K extends string, D extends z.ZodType>(kind: K, data: D) =>
  z
    .object({
      id: z.number().int().min(1),
      kind: z.literal(kind),
      at: z.number().int(),
      taskId: z.string().min(1).max(128).nullable(),
      data,
    })
    .strict();

/** One card of the agent's thread (M11R72), `data` by `kind`. Never sent to a model. */
export const AgentEventView = z.discriminatedUnion("kind", [
  card("schedule", RunCardData),
  card("task", RunCardData),
  card("isolated", IsolatedCardData),
  card("delegation", DelegationCardData),
  card("reminder", ReminderCardData),
  card("notify", NotifyCardData),
  card("egress_refused", EgressRefusedCardData),
]);
export type AgentEventView = z.infer<typeof AgentEventView>;
export type AgentEventKind = AgentEventView["kind"];
/** The `data` schema of each kind, for the write side. */
export const AGENT_EVENT_DATA = {
  schedule: RunCardData,
  task: RunCardData,
  isolated: IsolatedCardData,
  delegation: DelegationCardData,
  reminder: ReminderCardData,
  notify: NotifyCardData,
  egress_refused: EgressRefusedCardData,
} as const;

/** What `agents.status` says (M11R76): the day's spend against the agent's budget, then its newest work. */
export const AgentSpendFigures = z
  .object({
    usd: z.number().min(0),
    tokens: z.number().int().min(0),
    budgetUsd: z.number().min(0).nullable(),
    budgetTokens: z.number().int().min(0).nullable(),
  })
  .strict();

export const AgentsStreamEvent = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("snapshot"),
      agents: z.array(AgentSummary).max(AGENT_LIMITS.perOwner),
      requests: z.array(AgentRequestView).max(AGENTS_STREAM_LIMITS.requests),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("agent"), agent: AgentSummary }).strict(),
  z.object({ kind: z.literal("agent_removed"), id: AgentId }).strict(),
  z.object({ kind: z.literal("request"), request: AgentRequestView }).strict(),
  z.object({ kind: z.literal("request_closed"), id: z.string().min(1).max(64) }).strict(),
  /** A card was written or moved (M11R72): the open agent tab reads the page again. */
  z.object({ kind: z.literal("event"), agentId: AgentId, eventId: z.number().int().min(1) }).strict(),
]);
export type AgentsStreamEvent = z.infer<typeof AgentsStreamEvent>;
