import {
  BUILTIN_DENY_IDS,
  DenyPattern,
  MAX_SETTINGS_BYTES,
  HostPattern,
  MAX_ALLOW_HOSTS,
  MAX_DENY_PATTERNS,
  PolicySettings,
  type ApprovalMode,
} from "@pap/contracts";

export interface LineError {
  readonly line: number;
  readonly reason: "invalid" | "too_many";
}
export interface ParsedLines {
  readonly values: string[];
  readonly errors: LineError[];
}

/** One entry per line: blank lines are ignored, line numbers are the person's own (blank lines count). */
export function parsePatternLines(
  text: string,
  schema: { safeParse(value: string): { success: boolean } },
  max: number,
): ParsedLines {
  const values: string[] = [];
  const errors: LineError[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "") return;
    if (!schema.safeParse(raw).success) errors.push({ line: index + 1, reason: "invalid" });
    else if (values.length >= max) errors.push({ line: index + 1, reason: "too_many" });
    else values.push(raw);
  });
  return { values, errors };
}

export interface SettingsForm {
  readonly defaultMode: ApprovalMode;
  readonly builtinDenylist: boolean;
  readonly denylistText: string;
  readonly hostsOn: boolean;
  readonly hostsText: string;
}

/** The document as the wire types it: a field the daemon left out is its default. */
export type StoredSettings = { [K in keyof PolicySettings]?: PolicySettings[K] | undefined };

export function formOf(stored: StoredSettings): SettingsForm {
  const settings = PolicySettings.parse(stored);
  return {
    defaultMode: settings.defaultMode,
    builtinDenylist: settings.builtinDenylist,
    denylistText: settings.denylist.join("\n"),
    hostsOn: settings.allowHosts !== null,
    hostsText: (settings.allowHosts ?? []).join("\n"),
  };
}

export interface FormCheck {
  readonly deny: ParsedLines;
  /** Empty while the switch is off: a list that is not in force cannot block a save. */
  readonly hosts: ParsedLines;
  readonly tooLarge: boolean;
  readonly valid: boolean;
  /** What Save sends; null while the form is not valid. */
  readonly settings: PolicySettings | null;
}

export function checkForm(form: SettingsForm): FormCheck {
  const deny = parsePatternLines(form.denylistText, DenyPattern, MAX_DENY_PATTERNS);
  const hosts: ParsedLines = form.hostsOn
    ? parsePatternLines(form.hostsText, HostPattern, MAX_ALLOW_HOSTS)
    : { values: [], errors: [] };
  const candidate = PolicySettings.safeParse({
    defaultMode: form.defaultMode,
    builtinDenylist: form.builtinDenylist,
    denylist: deny.values,
    allowHosts: form.hostsOn ? hosts.values : null,
  });
  const tooLarge =
    candidate.success && new TextEncoder().encode(JSON.stringify(candidate.data)).length > MAX_SETTINGS_BYTES;
  const valid = candidate.success && !tooLarge && deny.errors.length === 0 && hosts.errors.length === 0;
  return { deny, hosts, tooLarge, valid, settings: valid && candidate.success ? candidate.data : null };
}

const canon = (stored: StoredSettings): string => {
  const settings = PolicySettings.parse(stored);
  return JSON.stringify([
    settings.defaultMode,
    settings.builtinDenylist,
    settings.denylist,
    settings.allowHosts,
  ]);
};

/** Whether the stored document is the one we tried to write (after a timeout, R105). */
export const sameSettings = (stored: StoredSettings | null, wanted: PolicySettings): boolean =>
  stored !== null && canon(stored) === canon(wanted);

export interface RuleRow {
  readonly id: string;
  readonly scope: string;
  readonly tool: string;
  readonly label: string;
  readonly createdAt: number;
}
export interface RuleGroup {
  readonly scope: string;
  readonly rules: RuleRow[];
}

/** Groups by project, the project with the newest rule first; newest first inside a group. */
export function groupRules(rules: readonly RuleRow[]): RuleGroup[] {
  const byScope = new Map<string, RuleRow[]>();
  for (const rule of rules) byScope.set(rule.scope, [...(byScope.get(rule.scope) ?? []), rule]);
  const newest = (list: readonly RuleRow[]) => Math.max(...list.map((rule) => rule.createdAt));
  return [...byScope.entries()]
    .map(([scope, list]) => ({
      scope,
      rules: [...list].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => newest(b.rules) - newest(a.rules) || a.scope.localeCompare(b.scope));
}

/** Bidi and other invisible controls are removed from text a worker or a model chose (M2-RT-42); tab and newline stay. */
export const plain = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === "\t" || character === "\n" ? character : "",
  );

const LABEL_CODE_POINTS = 200;
export function clipLabel(label: string): string {
  const points = [...plain(label)];
  return points.length > LABEL_CODE_POINTS
    ? `${points.slice(0, LABEL_CODE_POINTS).join("")}…`
    : points.join("");
}

/** The last two segments of the project path; the full path stays in the accessible name. */
export const shortScope = (scope: string): string =>
  plain(scope).split("/").filter(Boolean).slice(-2).join("/");

export const dayOf = (millis: number): string =>
  Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString().slice(0, 10) : "";

export const BUILTIN_IDS = BUILTIN_DENY_IDS;
export const BUILTIN_RESIDUALS = [
  "variables",
  "aliases",
  "expansion",
  "quoting",
  "cd",
  "stdin",
  "interpreters",
] as const;
