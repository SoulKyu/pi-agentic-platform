import {
  AUTOMATION_LIMITS,
  AUTOMATION_READ_TOOLS,
  AUTOMATION_WRITE_TOOLS,
  HMAC_HEADERS,
  nextOccurrences,
  OUTSIDE_TEXT_SOURCES,
  parseRrule,
  presetOfTools,
  Rrule,
  TimeZone,
  ToolName,
  type TriggerInput,
  TriggerSaveInput,
  type TriggerView,
} from "@pap/contracts";
import { t, type MessageKey } from "../../i18n/index.ts";

export type SourceType = "schedule" | "webhook" | "feed" | "manual";
export type Mode = "read-only" | "supervised" | "auto-accept-edits";

/** The form as typed: numbers stay text until `toInput`. `null` means "the default of the source", chosen by the contract's `withDefaults`. */
export interface Draft {
  readonly name: string;
  readonly enabled: boolean;
  readonly sourceType: SourceType;
  readonly rrule: string;
  readonly timezone: string;
  readonly catchUp: "skip" | "once";
  readonly format: "raw" | "alertmanager" | "grafana";
  readonly auth: "secret" | "hmac";
  readonly hmacHeader: (typeof HMAC_HEADERS)[number];
  readonly dedupMinutes: string;
  readonly onResolved: "skip" | "run";
  readonly feedUrl: string;
  readonly feedEvery: string;
  readonly cwd: string;
  /** The agent the trigger runs as; "" is a project trigger that runs in `cwd` (M11R127). */
  readonly agentId: string;
  readonly target: "isolated" | "thread";
  /** An isolated task keeps its folder between runs; sent only with an isolated agent target. */
  readonly keep: boolean;
  readonly tools: readonly string[];
  readonly mode: Mode | null;
  readonly precheck: string;
  readonly env: readonly string[];
  readonly retryOnInterrupt: boolean;
  readonly maxRunMinutes: string;
  /** null: the default of the source; "": no cap, chosen. */
  readonly maxRunUsd: string | null;
  readonly dailyBudgetUsd: string;
  readonly prompt: string;
}

export const RRULE_PRESETS = {
  hourly: "FREQ=HOURLY;BYMINUTE=0",
  daily: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
  weekly: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
} as const;

/** A new trigger: the project's folder and the browser's zone (RT-34). */
export function emptyDraft(cwd: string, timezone: string): Draft {
  const { dedupMinutes, feedEveryMinutes, maxRunMinutes } = AUTOMATION_LIMITS;
  return {
    name: "",
    enabled: false,
    sourceType: "schedule",
    rrule: RRULE_PRESETS.daily,
    timezone,
    catchUp: "skip",
    format: "raw",
    auth: "secret",
    hmacHeader: "x-pap-signature-256",
    dedupMinutes: String(dedupMinutes.fallback),
    onResolved: "skip",
    feedUrl: "",
    feedEvery: String(feedEveryMinutes.fallback),
    cwd,
    agentId: "",
    target: "isolated",
    keep: false,
    tools: [...AUTOMATION_READ_TOOLS],
    mode: null,
    precheck: "",
    env: [],
    retryOnInterrupt: false,
    maxRunMinutes: String(maxRunMinutes.fallback),
    maxRunUsd: null,
    dailyBudgetUsd: "",
    prompt: "",
  };
}

/** A new trigger that runs as an agent: no folder, an isolated task until the person picks the thread. */
export const agentDraft = (agentId: string, timezone: string): Draft => ({
  ...emptyDraft("", timezone),
  agentId,
});

/** Outside text (a webhook, a feed) never reaches an agent's thread (C §6.1): those sources run isolated, whatever the draft says. */
export const effectiveTarget = (draft: Draft): "isolated" | "thread" =>
  OUTSIDE_TEXT_SOURCES.has(draft.sourceType) ? "isolated" : draft.target;

export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The draft of a saved trigger, or null when its stored config no longer parses. */
export function draftOf(view: TriggerView, fallback: Draft): Draft | null {
  const { source, execution, prompt } = view;
  if (source === null || execution === null || prompt === null) return null;
  const base: Draft = {
    ...fallback,
    name: view.name,
    enabled: view.enabled,
    sourceType: source.type,
    cwd: execution.cwd ?? "",
    agentId: execution.agent?.agentId ?? "",
    target: execution.agent?.target ?? "isolated",
    keep: execution.agent?.keep === true,
    tools: [...execution.tools],
    mode: execution.mode ?? null,
    precheck: execution.precheck ?? "",
    env: [...execution.env],
    retryOnInterrupt: execution.retryOnInterrupt,
    maxRunMinutes: String(execution.maxRunMinutes),
    maxRunUsd:
      execution.maxRunUsd === undefined
        ? null
        : execution.maxRunUsd === null
          ? ""
          : String(execution.maxRunUsd),
    dailyBudgetUsd: execution.dailyBudgetUsd === null ? "" : String(execution.dailyBudgetUsd),
    prompt,
  };
  switch (source.type) {
    case "schedule":
      return { ...base, rrule: source.rrule, timezone: source.timezone, catchUp: source.catchUp };
    case "webhook":
      return {
        ...base,
        format: source.format,
        auth: source.auth,
        hmacHeader: source.hmacHeader,
        dedupMinutes: String(source.dedupMinutes),
        onResolved: source.onResolved,
      };
    case "feed":
      return { ...base, feedUrl: source.url, feedEvery: String(source.everyMinutes) };
    case "manual":
      return base;
  }
}

export const isDirty = (draft: Draft, baseline: Draft): boolean =>
  JSON.stringify(draft) !== JSON.stringify(baseline);

/** "Fire now" fires the saved trigger: it needs one, and no unsaved change (the tooltip says "Save first"). */
export const fireNowEnabled = (draft: Draft, baseline: Draft, savedId: string | null): boolean =>
  savedId !== null && !isDirty(draft, baseline);

// ---- defaults of the source, as the contract's `withDefaults` makes them (owner m10a4) ----

export function effectiveMode(draft: Draft): Mode {
  return draft.mode ?? (OUTSIDE_TEXT_SOURCES.has(draft.sourceType) ? "supervised" : "auto-accept-edits");
}

/** The text of the dollar cap the form shows: "" is no cap. */
export function effectiveUsd(draft: Draft): string {
  return draft.maxRunUsd ?? (OUTSIDE_TEXT_SOURCES.has(draft.sourceType) ? "1" : "");
}

// ---- draft to input ----

/** A blank number is left out so the contract's default applies; any other text goes through, and `NaN` is refused there. */
const num = (text: string): number | undefined => (text.trim() === "" ? undefined : Number(text));

function sourceOf(draft: Draft): Record<string, unknown> {
  switch (draft.sourceType) {
    case "schedule":
      return {
        type: "schedule",
        rrule: draft.rrule.trim(),
        timezone: draft.timezone,
        catchUp: draft.catchUp,
      };
    case "webhook":
      return {
        type: "webhook",
        format: draft.format,
        auth: draft.auth,
        hmacHeader: draft.hmacHeader,
        dedupMinutes: num(draft.dedupMinutes),
        onResolved: draft.onResolved,
      };
    case "feed":
      return { type: "feed", url: draft.feedUrl.trim(), everyMinutes: num(draft.feedEvery) };
    case "manual":
      return { type: "manual" };
  }
}

export type InputResult =
  | { readonly ok: true; readonly input: TriggerInput }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** The draft through the contract's own `TriggerSaveInput`: its refusals, keyed by path (`source.rrule`, `prompt`...), are the form's errors. */
export function toInput(draft: Draft): InputResult {
  const onThread = draft.agentId !== "" && effectiveTarget(draft) === "thread";
  const maxRunUsd =
    draft.maxRunUsd === null ? undefined : draft.maxRunUsd === "" ? null : Number(draft.maxRunUsd);
  const parsed = TriggerSaveInput.safeParse({
    name: draft.name,
    enabled: draft.enabled,
    source: sourceOf(draft),
    execution: {
      ...(draft.agentId === ""
        ? { cwd: draft.cwd.trim() }
        : {
            agent: {
              agentId: draft.agentId,
              target: effectiveTarget(draft),
              ...(draft.keep && !onThread ? { keep: true } : {}),
            },
          }),
      tools: onThread ? undefined : [...draft.tools],
      mode: onThread ? undefined : (draft.mode ?? undefined),
      precheck: draft.precheck.trim() === "" ? null : draft.precheck,
      env: [...draft.env],
      retryOnInterrupt: draft.retryOnInterrupt,
      maxRunMinutes: num(draft.maxRunMinutes),
      maxRunUsd,
      dailyBudgetUsd: num(draft.dailyBudgetUsd) ?? null,
    },
    prompt: draft.prompt,
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) errors[issue.path.join(".")] ??= pap(issue.message);
  return { ok: false, errors };
}

/** The contract's refusals that the form words itself (W5-R32): the person never sees the raw text. */
const pap = (message: string): string => {
  if (message === "{{precheck}} is for isolated tasks") return t("automation.editor.threadPrecheck");
  if (message === "prechecks were removed") return t("automation.editor.precheck.removed");
  if (message.startsWith("{{precheck}} was removed") || message === "{{precheck}} needs a precheck command")
    return t("automation.editor.prompt.precheckRemoved");
  return message;
};

const FIELD_TEXT: Readonly<Record<string, (draft: Draft) => string>> = {
  name: (d) => d.name,
  "source.rrule": (d) => d.rrule,
  "source.url": (d) => d.feedUrl,
  "execution.cwd": (d) => d.cwd,
  "execution.agent": (d) => d.agentId,
  "execution.precheck": (d) => d.precheck,
  prompt: (d) => d.prompt,
};

/** An error shows once the person tried to save or dry-run, or as soon as its field holds something (an empty field is not yet wrong). */
export function shownErrors(
  errors: Readonly<Record<string, string>>,
  draft: Draft,
  attempted: boolean,
): Readonly<Record<string, string>> {
  if (attempted) return errors;
  return Object.fromEntries(
    Object.entries(errors).filter(([path]) => {
      const text = FIELD_TEXT[path];
      return text !== undefined && text(draft).trim() !== "";
    }),
  );
}

// ---- tools ----

export const BASE_TOOLS: readonly string[] = [...AUTOMATION_READ_TOOLS, ...AUTOMATION_WRITE_TOOLS];

/** The checkboxes: Pi's seven tools, then the names the person added. */
export const toolRows = (tools: readonly string[]): string[] => [
  ...BASE_TOOLS,
  ...tools.filter((tool) => !BASE_TOOLS.includes(tool)),
];

/** Pi's tools the list leaves out: shown struck through. */
export const struckTools = (tools: readonly string[]): string[] =>
  BASE_TOOLS.filter((tool) => !tools.includes(tool));

export function setTool(tools: readonly string[], name: string, on: boolean): string[] {
  const next = on ? [...tools, name] : tools.filter((tool) => tool !== name);
  return toolRows(next).filter((tool) => next.includes(tool));
}

export function toolProblem(name: string, tools: readonly string[]): "bad" | "duplicate" | "limit" | null {
  if (!ToolName.safeParse(name).success) return "bad";
  if (tools.includes(name)) return "duplicate";
  return tools.length >= AUTOMATION_LIMITS.tools ? "limit" : null;
}

const hasWriteTool = (tools: readonly string[]): boolean =>
  tools.some((tool) => (AUTOMATION_WRITE_TOOLS as readonly string[]).includes(tool));

export const modeNoteKey = (mode: Mode): MessageKey => `automation.editor.note.${mode}`;

/** RT-13 and RT-28: what asks under the chosen mode (once `bash`, `edit` or `write` is listed), and that the preset is off. */
export function toolNotes(mode: Mode, tools: readonly string[]): MessageKey[] {
  return [
    ...(hasWriteTool(tools) ? [modeNoteKey(mode)] : []),
    ...(presetOfTools(tools) === "full" ? (["automation.editor.note.preset"] as const) : []),
  ];
}

// ---- the schedule preview ----

export type RrulePreview =
  | { readonly ok: true; readonly times: readonly number[] }
  | {
      readonly ok: false;
      readonly message: string;
      readonly missing: "BYHOUR" | null;
    };

/** The next fires in the trigger's zone; a refusal carries the contract's own text (`Rrule`, `TimeZone`). */
export function rrulePreview(rrule: string, timezone: string, now: number, count = 5): RrulePreview {
  const rule = Rrule.safeParse(rrule.trim());
  if (!rule.success) {
    const needsHour = /^FREQ=(?:DAILY|WEEKLY)(?:;|$)/.test(rrule.trim()) && !/(?:^|;)BYHOUR=/.test(rrule);
    return { ok: false, message: rule.error.issues[0]?.message ?? "", missing: needsHour ? "BYHOUR" : null };
  }
  const zone = TimeZone.safeParse(timezone);
  if (!zone.success) return { ok: false, message: zone.error.issues[0]?.message ?? "", missing: null };
  const parsed = parseRrule(rule.data);
  if (!parsed.ok) return { ok: false, message: parsed.reason, missing: null };
  return { ok: true, times: nextOccurrences(parsed.rule, zone.data, now, count) };
}

/** The zones the select offers: the runtime's list, with the draft's own zone and UTC always there. */
export function zoneOptions(current: string): string[] {
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const extra = [current, "UTC"].filter(
    (zone, index, all) => zone !== "" && !known.includes(zone) && all.indexOf(zone) === index,
  );
  return [...extra, ...known];
}
