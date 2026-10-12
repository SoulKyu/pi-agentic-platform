import type { KeybindingRule } from "@pap/contracts";
import { KEY_NONE } from "@pap/contracts";
import { chordId, matchesChord, parseChord, type Chord, type KeyInput, type Platform } from "./keys.ts";
import { evaluateWhen, mentions, parseWhen, type WhenNode } from "./when.ts";

export interface ResolvedRule {
  readonly chord: Chord;
  readonly command: string;
  readonly when: WhenNode | null;
  readonly whenText: string | null;
  readonly source: "default" | "user";
  /** Index in its source list (the user's JSON array for user rules). */
  readonly index: number;
}
export interface RuleIssue {
  readonly index: number;
  readonly problem: "key" | "when" | "command";
}

function resolveRule(
  rule: KeybindingRule,
  source: ResolvedRule["source"],
  index: number,
  known: ReadonlySet<string>,
): ResolvedRule | RuleIssue["problem"] {
  if (!known.has(rule.command)) return "command";
  const chord = parseChord(rule.key);
  if (!chord) return "key";
  const when = rule.when === undefined ? null : parseWhen(rule.when);
  if (when && "error" in when) return "when";
  return { chord, command: rule.command, when, whenText: rule.when ?? null, source, index };
}

/** T3: user rules replace the defaults of the commands they name (`none` replaces and binds nothing); later wins. */
export function mergeWithDefaults(
  defaults: readonly KeybindingRule[],
  user: readonly KeybindingRule[],
  known: ReadonlySet<string>,
): { rules: ResolvedRule[]; issues: RuleIssue[] } {
  const issues: RuleIssue[] = [];
  const userRules: ResolvedRule[] = [];
  const overridden = new Set<string>();
  user.forEach((rule, index) => {
    if (typeof rule.key === "string" && rule.key.trim().toLowerCase() === KEY_NONE) {
      if (known.has(rule.command)) overridden.add(rule.command);
      else issues.push({ index, problem: "command" });
      return;
    }
    const resolved = resolveRule(rule, "user", index, known);
    if (typeof resolved === "string") issues.push({ index, problem: resolved });
    else {
      overridden.add(resolved.command);
      userRules.push(resolved);
    }
  });
  const kept = defaults
    .map((rule, index) => resolveRule(rule, "default", index, known))
    .filter((rule): rule is ResolvedRule => typeof rule !== "string" && !overridden.has(rule.command));
  return { rules: [...kept, ...userRules], issues };
}

const isBarePrintable = (chord: Chord) =>
  !chord.ctrl && !chord.meta && !chord.alt && !chord.mod && [...chord.key].length === 1 && chord.key !== " ";

/** Commands whose rule matches, last rule first, each once. The dispatcher tries them in this order. */
export function matchingCommands(
  event: KeyInput,
  rules: readonly ResolvedRule[],
  context: Readonly<Record<string, boolean>>,
  platform: Platform,
): string[] {
  const out: string[] = [];
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i] as ResolvedRule;
    if (!matchesChord(rule.chord, event, platform)) continue;
    if (
      isBarePrintable(rule.chord) &&
      context.editableFocus === true &&
      !(rule.when && mentions(rule.when, "editableFocus"))
    )
      continue;
    // An extension's terminal-input panel owns its keys (agreement 7): a rule fires there only if its clause says so.
    if (context.panelFocus === true && !(rule.when && mentions(rule.when, "panelFocus"))) continue;
    if (rule.when && !evaluateWhen(rule.when, context)) continue;
    if (!out.includes(rule.command)) out.push(rule.command);
  }
  return out;
}

/** The atoms a clause requires, as `name` / `!name`: its top-level conjuncts only; any other shape contributes none. */
function requiredAtoms(node: WhenNode | null, out: Set<string> = new Set()): Set<string> {
  if (node === null) return out;
  if (node.type === "and") {
    requiredAtoms(node.left, out);
    requiredAtoms(node.right, out);
  } else if (node.type === "id") out.add(node.name);
  else if (node.type === "not" && node.node.type === "id") out.add(`!${node.node.name}`);
  return out;
}

/** True only when one clause needs an atom and the other needs its negation, so they never hold together. */
function provablyExclusive(a: ResolvedRule, b: ResolvedRule): boolean {
  const left = requiredAtoms(a.when);
  const right = requiredAtoms(b.when);
  for (const atom of left) {
    const opposite = atom.startsWith("!") ? atom.slice(1) : `!${atom}`;
    if (right.has(opposite)) return true;
  }
  return false;
}

/**
 * Like T3 keybindingConflictLabels, but stricter: same chord, and the clauses are not provably exclusive. Keyed by position in `rules`.
 * Rules are grouped by chord first, so only rules sharing a chord are compared (at most defaults + 256 user rules).
 */
export function conflictsOf(rules: readonly ResolvedRule[], platform: Platform): Map<number, string[]> {
  const groups = new Map<string, number[]>();
  rules.forEach((rule, i) => {
    const id = chordId(rule.chord, platform);
    const group = groups.get(id);
    if (group) group.push(i);
    else groups.set(id, [i]);
  });
  const out = new Map<number, string[]>();
  for (const group of groups.values()) {
    for (const i of group) {
      const a = rules[i] as ResolvedRule;
      const others = group
        .map((j) => rules[j] as ResolvedRule)
        .filter((b) => b !== a && b.command !== a.command && !provablyExclusive(a, b));
      if (others.length > 0) out.set(i, [...new Set(others.map((b) => b.command))]);
    }
  }
  return out;
}

const DIGITS = Array.from({ length: 9 }, (_, i) => String(i + 1));
const RESERVED: Readonly<Record<Platform, ReadonlySet<string>>> = {
  mac: new Set([
    "meta+w",
    "meta+t",
    "meta+n",
    "shift+meta+n",
    "shift+meta+t",
    "meta+q",
    "meta+l",
    "ctrl+tab",
    "ctrl+shift+tab",
    ...DIGITS.map((d) => `meta+${d}`),
  ]),
  other: new Set([
    "ctrl+w",
    "ctrl+t",
    "ctrl+n",
    "ctrl+shift+n",
    "ctrl+shift+t",
    "ctrl+shift+w",
    "ctrl+l",
    "ctrl+tab",
    "ctrl+shift+tab",
    "ctrl+pageup",
    "ctrl+pagedown",
    "alt+f4",
    ...DIGITS.map((d) => `ctrl+${d}`),
    ...DIGITS.map((d) => `alt+${d}`),
  ]),
};

/** Chords the browser or the OS usually keeps before the page sees them (Review Focus 4). */
export const isReserved = (chord: Chord, platform: Platform): boolean =>
  RESERVED[platform].has(chordId(chord, platform));
