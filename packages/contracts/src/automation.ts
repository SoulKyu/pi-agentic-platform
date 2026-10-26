import { z } from "zod";
import { ClientPath } from "./client-path.ts";

import { isNeverPassedEnvKey } from "./child-env.ts";
import { AgentId } from "./platform.ts";
import { INVISIBLE, ToolName } from "./policy.ts";
import { isSupportedRrule } from "./rrule.ts";

/** Every bound of M10's automation, in one place: the daemon and the editor read the same numbers. */
export const AUTOMATION_LIMITS = {
  triggersPerOwner: 200,
  nameChars: 80,
  promptChars: 16_384,
  precheckChars: 2_048,
  tools: 32,
  envNames: 16,
  payloadBytes: 65_536,
  maxRunMinutes: { min: 1, max: 240, fallback: 20 },
  dedupMinutes: { min: 1, max: 1_440, fallback: 10 },
  feedEveryMinutes: { min: 15, max: 1_440, fallback: 360 },
  queuedPerTrigger: 20,
  webhookPerMinute: 60,
  feedEntriesPerTask: 10,
  journalPerTrigger: 500,
  precheckTimeoutMs: 30_000,
  precheckOutputBytes: 4_096,
  /** An unattended question waits this long, then is denied and the run goes on (owner m10a3, C §5.3). */
  inputWaitMinutes: 10,
  slots: { min: 1, max: 8, fallback: 2 },
} as const;

export const PROMPT_PLACEHOLDERS = ["payload", "precheck", "trigger", "firedAt"] as const;
export type PromptPlaceholder = (typeof PROMPT_PLACEHOLDERS)[number];
/** `{{ name }}`; the name is whatever sits between the braces, so `{{ x y }}` is an unknown placeholder, not text. */
export const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Pi's read-only coding tools: the default allowlist of a trigger, and the only names that keep the read-only preset. */
export const AUTOMATION_READ_TOOLS = ["read", "grep", "find", "ls"] as const;
/** Coding tools that change the machine: a trigger may list them, and the policy still asks per its mode. */
export const AUTOMATION_WRITE_TOOLS = ["bash", "edit", "write"] as const;
/** The preset of a run (RT-28): `read-only` only when every listed tool is one of Pi's read tools; else `full`, and the
 * approval matrix decides (an MCP write tool listed by the owner then asks instead of being blocked by MC36). */
export function presetOfTools(tools: readonly string[]): "read-only" | "full" {
  return tools.every((tool) => (AUTOMATION_READ_TOOLS as readonly string[]).includes(tool))
    ? "read-only"
    : "full";
}
/** Never `full-access`: an unattended run has no sandbox before M11 (owner m10q4). */
export const AUTOMATION_MODES = ["read-only", "supervised", "auto-accept-edits"] as const;
export const WEBHOOK_FORMATS = ["raw", "alertmanager", "grafana"] as const;
/** `secret` (Alertmanager, Grafana's header) or `hmac` (GitHub, Grafana's signature); no combined mode (owner m10a5). */
export const WEBHOOK_AUTH = ["secret", "hmac"] as const;
export const HMAC_HEADERS = [
  "x-pap-signature-256",
  "x-hub-signature-256",
  "x-grafana-alerting-signature",
] as const;
/** Sources whose prompt carries text from outside (fenced, the run tainted): stricter defaults (owner m10a4, RT-08). */
export const OUTSIDE_TEXT_SOURCES: ReadonlySet<string> = new Set(["webhook", "feed"]);

const codePoints = (text: string): number => [...text].length;
const intIn = (range: { readonly min: number; readonly max: number; readonly fallback: number }) =>
  z.number().int().min(range.min).max(range.max).default(range.fallback);
// Tab and line feed are text; every other control, format (bidi, zero-width) or separator character is refused.
// eslint-disable-next-line no-control-regex -- the control characters are what this pattern refuses
const HIDDEN_IN_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;

export const TriggerName = z
  .string()
  .trim()
  .min(1)
  .max(AUTOMATION_LIMITS.nameChars * 4)
  .refine((name) => !INVISIBLE.test(name), "a name is one line of visible characters")
  .refine((name) => codePoints(name) <= AUTOMATION_LIMITS.nameChars, "a name has at most 80 characters");

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
/** An IANA zone this runtime knows; the browser checks with the same Intl call (Safari 16.4 has it). */
export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/)
  .refine(isTimeZone, "a time zone this server knows");

/** The bounded shape, then `parseRrule` (`rrule.ts`) decides whether pap supports the rule. */
export const Rrule = z
  .string()
  .min(9)
  .max(256)
  .regex(/^FREQ=[A-Z]+(?:;[A-Z]+=[A-Z0-9,+-]+)*$/)
  .refine(isSupportedRrule, "a schedule pap supports");

export const ScheduleSource = z
  .object({
    type: z.literal("schedule"),
    rrule: Rrule,
    timezone: TimeZone,
    catchUp: z.enum(["skip", "once"]).default("skip"),
  })
  .strict();

export const WebhookSource = z
  .object({
    type: z.literal("webhook"),
    format: z.enum(WEBHOOK_FORMATS).default("raw"),
    auth: z.enum(WEBHOOK_AUTH).default("secret"),
    hmacHeader: z.enum(HMAC_HEADERS).default("x-pap-signature-256"),
    dedupMinutes: intIn(AUTOMATION_LIMITS.dedupMinutes),
    /** Alertmanager and Grafana send a notification when an alert resolves: by default it starts no run. */
    onResolved: z.enum(["skip", "run"]).default("skip"),
  })
  .strict();

// No `URL.canParse` (Safari 16.4): `new URL` in a try. The address guard (`feedUrlRefusal`) runs again at save and at each poll.
function isFeedUrl(text: string): boolean {
  if (text !== text.trim() || INVISIBLE.test(text)) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname !== "";
}
export const FeedUrl = z.string().min(9).max(2048).refine(isFeedUrl, "an https address without credentials");

export const FeedSource = z
  .object({
    type: z.literal("feed"),
    url: FeedUrl,
    everyMinutes: intIn(AUTOMATION_LIMITS.feedEveryMinutes),
  })
  .strict();

export const ManualSource = z.object({ type: z.literal("manual") }).strict();

export const TriggerSource = z.discriminatedUnion("type", [
  ScheduleSource,
  WebhookSource,
  FeedSource,
  ManualSource,
]);
export type TriggerSource = z.infer<typeof TriggerSource>;

// `ToolName` (a tool's registered name as Pi lists it) lives in policy.ts beside `PolicyRules`, which uses it: no import cycle.
export const ToolAllowlist = z
  .array(ToolName)
  .min(1)
  .max(AUTOMATION_LIMITS.tools)
  .refine((tools) => new Set(tools).size === tools.length, "each tool once");

/**
 * The name of a daemon variable the precheck keeps (owner m10q7: names, never values). An exact name, and never one the
 * shared child environment withholds (`isNeverPassedEnvKey`, M9's `child-env.ts`, c7): the SSH agent, provider keys,
 * forge tokens never reach a precheck, so the editor refuses them before a save.
 */
export const EnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .refine((name) => !isNeverPassedEnvKey(name), "never passed to an unattended child");

const AbsoluteFolder = ClientPath;

export const PrecheckCommand = z
  .string()
  .trim()
  .min(1)
  .max(AUTOMATION_LIMITS.precheckChars)
  .refine((command) => !HIDDEN_IN_TEXT.test(command), "visible text, tabs and new lines only");

/** Where an agent trigger runs (M11R65): `isolated`, a fresh task in the agent's sandbox; `thread`, a prompt in its thread. */
export const TRIGGER_TARGETS = ["isolated", "thread"] as const;
export const TriggerAgent = z
  .object({
    agentId: AgentId,
    target: z.enum(TRIGGER_TARGETS),
    /** An isolated task keeps its folder (a disk of its own) between this trigger's runs; absent reads as off. */
    keep: z.boolean().optional(),
  })
  .strict();
export type TriggerAgent = z.infer<typeof TriggerAgent>;

export const TriggerExecution = z
  .object({
    /** A folder as `sessions.create` takes it; the daemon resolves it (`invalid_cwd`) when saving and at each start. Exactly one of `cwd` and `agent`. */
    cwd: AbsoluteFolder.optional(),
    agent: TriggerAgent.nullable().default(null),
    tools: ToolAllowlist.default([...AUTOMATION_READ_TOOLS]),
    /** Absent: `supervised` for webhook and feed triggers, `auto-accept-edits` otherwise (`withDefaults`, owner m10a4). */
    mode: z.enum(AUTOMATION_MODES).optional(),
    precheck: PrecheckCommand.nullable().default(null),
    /** Daemon variables the precheck receives by name (owner m10q7); the values stay in the daemon's environment. */
    env: z
      .array(EnvName)
      .max(AUTOMATION_LIMITS.envNames)
      .refine((names) => new Set(names).size === names.length, "each name once")
      .default([]),
    retryOnInterrupt: z.boolean().default(false),
    maxRunMinutes: intIn(AUTOMATION_LIMITS.maxRunMinutes),
    /** Absent: $1 for webhook and feed triggers, no cap otherwise (`withDefaults`, RT-08); null: no cap, chosen. */
    maxRunUsd: z.number().min(0.01).max(100).nullable().optional(),
    dailyBudgetUsd: z.number().min(0).max(1000).nullable().default(null),
  })
  .strict();

export const PromptTemplate = z
  .string()
  .min(1)
  .max(AUTOMATION_LIMITS.promptChars)
  .superRefine((text, ctx) => {
    if (HIDDEN_IN_TEXT.test(text))
      ctx.addIssue({ code: "custom", message: "visible text, tabs and new lines only" });
    const seen = new Map<string, number>();
    for (const match of text.matchAll(PLACEHOLDER)) {
      const name = match[1] ?? "";
      if (!(PROMPT_PLACEHOLDERS as readonly string[]).includes(name))
        ctx.addIssue({ code: "custom", message: "unknown placeholder" });
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    // One payload and one precheck at most: each copy of a 64 KiB payload would grow the task's prompt (RT-24).
    if ((seen.get("payload") ?? 0) > 1 || (seen.get("precheck") ?? 0) > 1)
      ctx.addIssue({ code: "custom", message: "{{payload}} and {{precheck}} at most once each" });
  });

const DEFAULT_OUTSIDE_RUN_USD = 1;

/** The defaults that depend on the source, made explicit before the input is stored (owner m10a4, RT-08). */
function withDefaults<T extends { source: TriggerSource; execution: z.infer<typeof TriggerExecution> }>(
  input: T,
) {
  const outside = OUTSIDE_TEXT_SOURCES.has(input.source.type);
  const { mode, maxRunUsd } = input.execution;
  return {
    ...input,
    execution: {
      ...input.execution,
      mode: mode ?? (outside ? "supervised" : "auto-accept-edits"),
      maxRunUsd: maxRunUsd === undefined ? (outside ? DEFAULT_OUTSIDE_RUN_USD : null) : maxRunUsd,
    },
  };
}

/** What the editor sends and the store keeps (never the secret): the trust boundary of every trigger write. */
export const TriggerInput = z
  .object({
    name: TriggerName,
    enabled: z.boolean().default(false),
    source: TriggerSource,
    execution: TriggerExecution,
    prompt: PromptTemplate,
  })
  .strict()
  .superRefine((input, ctx) => {
    const used = new Set([...input.prompt.matchAll(PLACEHOLDER)].map((match) => match[1]));
    if (used.has("precheck") && input.execution.precheck === null)
      ctx.addIssue({ code: "custom", path: ["prompt"], message: "{{precheck}} needs a precheck command" });
    if (input.execution.env.length > 0 && input.execution.precheck === null)
      ctx.addIssue({ code: "custom", path: ["execution", "env"], message: "variables are for the precheck" });
    const { cwd, agent } = input.execution;
    if ((cwd === undefined) === (agent === null))
      ctx.addIssue({ code: "custom", path: ["execution", "cwd"], message: "a folder or an agent, not both" });
    // C §6.1: outside text (a webhook, a feed) never reaches an agent's trusted thread; it runs in an isolated task.
    // W5-R32: a precheck's output is fenced and tainted, and the thread is the agent's trusted context.
    if (agent?.target === "thread" && used.has("precheck"))
      ctx.addIssue({ code: "custom", path: ["prompt"], message: "{{precheck}} is for isolated tasks" });
    if (agent?.target === "thread" && agent.keep === true)
      ctx.addIssue({
        code: "custom",
        path: ["execution", "agent", "keep"],
        message: "a thread keeps its own disk",
      });
    if (agent?.target === "thread" && OUTSIDE_TEXT_SOURCES.has(input.source.type))
      ctx.addIssue({
        code: "custom",
        path: ["execution", "agent"],
        message: "outside text runs in an isolated task",
      });
  })
  .transform(withDefaults);
export type TriggerInput = z.output<typeof TriggerInput>;

/** The journal word, manual-fire detail and dry-run output of a stored trigger that still holds a precheck (B6). */
export const PRECHECK_REMOVED = "precheck_removed";

/**
 * What a save accepts (B6): prechecks were removed, so a precheck command, its variable names and `{{precheck}}` are refused
 * on `create` and `update`. A stored trigger still parses as `TriggerInput`, so the form can show the old value to clear.
 */
export const TriggerSaveInput = TriggerInput.superRefine((input, ctx) => {
  if (input.execution.precheck !== null)
    ctx.addIssue({
      code: "custom",
      path: ["execution", "precheck"],
      message: "prechecks were removed",
    });
  if (input.execution.env.length > 0)
    ctx.addIssue({ code: "custom", path: ["execution", "env"], message: "variables were for prechecks" });
  if ([...input.prompt.matchAll(PLACEHOLDER)].some((match) => match[1] === "precheck"))
    ctx.addIssue({ code: "custom", path: ["prompt"], message: "{{precheck}} was removed with prechecks" });
});

const HHMM = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
/** The `automation` account setting (Settings › Automation), compare-and-set like every setting (owner R3-4). */
export const AutomationSettings = z
  .object({
    paused: z.boolean().default(false),
    /** This owner's running tasks at most; the worker reserve caps all of them (M10R139). */
    slots: intIn(AUTOMATION_LIMITS.slots),
    /** null: the server's own zone. The editor fills the browser's zone at the first save (RT-34). */
    timezone: TimeZone.nullable().default(null),
    /** Runs still execute in quiet hours (C §6.4); M12's pushes wait for the end. `from === to` is no window. */
    quietHours: z.object({ from: HHMM, to: HHMM }).strict().nullable().default(null),
    /** Automatic runs stop once today's API-equivalent cost reaches it; 0 refuses every one; null: no budget. */
    dailyBudgetUsd: z.number().min(0).max(1000).nullable().default(5),
    /** A member's cap, set by the owner (users.budget_usd); null for the owner. Read only: the server fills it on a read and drops it on a write (M14 RT-06). */
    dailyBudgetCapUsd: z.number().min(0).max(1000).nullable().default(null),
    autoResume: z.boolean().default(true),
  })
  .strict();
export type AutomationSettings = z.infer<typeof AutomationSettings>;

const MINUTES_PER_DAY = 1440;
const minuteOfDay = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The wall-clock minute of an instant in a zone (null: the server's own zone), 0 to 1439. */
function localMinute(timeZone: string | null, now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone === null ? {} : { timeZone }),
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return (part("hour") % 24) * 60 + part("minute");
}

/**
 * Whether `now` falls in the owner's quiet hours (M10R6). `from === to` is no window, `from > to` crosses midnight.
 * Runs still execute in quiet hours; M12's pushes wait for the end.
 */
export function inQuietHours(
  quiet: AutomationSettings["quietHours"],
  timeZone: string | null,
  now: number,
): boolean {
  if (quiet === null) return false;
  const from = minuteOfDay(quiet.from);
  const to = minuteOfDay(quiet.to);
  if (from === to) return false;
  const minute = localMinute(timeZone, now) % MINUTES_PER_DAY;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}
