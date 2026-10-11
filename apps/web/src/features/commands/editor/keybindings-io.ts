import { KEY_NONE, KeybindingRule } from "@pap/contracts";
import { KNOWN_COMMANDS } from "../defaults.ts";
import { parseChord, type Platform } from "../keys.ts";
import { detectPlatform } from "../labels.ts";
import { isReserved } from "../resolve.ts";
import { parseWhen } from "../when.ts";

export const MAX_KEYBINDINGS_FILE_BYTES = 65_536;
const MAX_RULES = 256;
const MAX_ISSUES = 20;
const FUNCTION_KEY = /^f\d{1,2}$/;

export type KeybindingsIssueProblem = "shape" | "key" | "when" | "command" | "reserved" | "altgr";
export interface KeybindingsIssue {
  readonly index: number;
  readonly problem: KeybindingsIssueProblem;
}
export type KeybindingsFileError = "too_large" | "not_json" | "not_array" | "too_many";
export type KeybindingsFileResult =
  | {
      readonly ok: true;
      readonly rules: KeybindingRule[];
      /** At most 20, in file order; `omittedIssues` counts the rest. */
      readonly issues: KeybindingsIssue[];
      readonly omittedIssues: number;
    }
  | { readonly ok: false; readonly error: KeybindingsFileError };

const TOO_LARGE: KeybindingsFileResult = { ok: false, error: "too_large" };

/** The first problem of one rule that passed the shape check; null when it is sound. */
function problemOf(
  rule: KeybindingRule,
  platform: Platform,
): Exclude<KeybindingsIssueProblem, "shape"> | null {
  if (!KNOWN_COMMANDS.has(rule.command)) return "command";
  const none = rule.key.trim().toLowerCase() === KEY_NONE;
  const chord = none ? null : parseChord(rule.key);
  if (!none && chord === null) return "key";
  if (rule.when !== undefined) {
    const when = parseWhen(rule.when);
    if ("error" in when) return "when";
  }
  if (chord === null) return null;
  if (isReserved(chord, platform)) return "reserved";
  // Where Ctrl+Alt is AltGr (Windows), the dispatcher cannot match it: kept, but it may never fire.
  return platform === "other" && chord.alt && (chord.ctrl || chord.mod) ? "altgr" : null;
}

/**
 * Imported text is untrusted: size (in bytes) first, then JSON, then the list, then each entry. An entry that is not a
 * rule or names an unknown command is dropped; an unreadable key or clause is kept (it is the user's text) and reported,
 * as is a reserved chord. Only indexes and problem kinds leave this function, never the file's own words.
 */
export function parseKeybindingsFile(
  text: string,
  platform: Platform = detectPlatform(),
): KeybindingsFileResult {
  if (new TextEncoder().encode(text).length > MAX_KEYBINDINGS_FILE_BYTES) return TOO_LARGE;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "not_json" };
  }
  if (!Array.isArray(value)) return { ok: false, error: "not_array" };
  if (value.length > MAX_RULES) return { ok: false, error: "too_many" };
  const rules: KeybindingRule[] = [];
  const issues: KeybindingsIssue[] = [];
  value.forEach((entry: unknown, index) => {
    const parsed = KeybindingRule.safeParse(entry);
    if (!parsed.success) {
      issues.push({ index, problem: "shape" });
      return;
    }
    const problem = problemOf(parsed.data, platform);
    if (problem !== "command") rules.push(parsed.data);
    if (problem !== null) issues.push({ index, problem });
  });
  return {
    ok: true,
    rules,
    issues: issues.slice(0, MAX_ISSUES),
    omittedIssues: Math.max(0, issues.length - MAX_ISSUES),
  };
}

/** The size is checked on the File before `text()`, so a huge file is never read into memory. */
export async function readKeybindingsFile(
  file: File,
  platform: Platform = detectPlatform(),
): Promise<KeybindingsFileResult> {
  if (file.size > MAX_KEYBINDINGS_FILE_BYTES) return TOO_LARGE;
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: "not_json" }; // an unreadable file reads as no JSON at all
  }
  return parseKeybindingsFile(text, platform);
}

export function exportKeybindingsFile(rules: readonly KeybindingRule[]): string {
  return `${JSON.stringify(rules, null, 2)}\n`;
}

/**
 * Why the recorder refuses a chord (null: accepted). A key alone would fire while typing, so a modifier is needed except
 * for the help key (whose default `when` already stays out of fields) and the function keys.
 */
export function recordedChordProblem(
  chord: string,
  command: string,
  platform: Platform,
): "no_modifier" | "reserved" | "unusable" | null {
  const parsed = parseChord(chord);
  if (parsed === null) return "unusable";
  if (isReserved(parsed, platform)) return "reserved";
  const modified = parsed.mod || parsed.ctrl || parsed.meta || parsed.alt;
  return modified || command === "shortcuts.help" || FUNCTION_KEY.test(parsed.key) ? null : "no_modifier";
}
